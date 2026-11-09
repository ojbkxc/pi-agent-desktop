# Skill market (fork)

A full page (not a Settings pane) that browses two third-party skill registries,
previews what a skill actually contains, and installs it into this machine under
the SDK's own skill root. Fork-owned end to end; nothing here is upstream pi-web.

## Why a page and two sources

cc-haha ships `ExtensionMarket` (plugins + skills, ClawHub + SkillHub) as a
full tab, not a settings form; this page mirrors that shape for skills only. The
Plugins pane keeps its own `pi-extensions` catalog, which is a different thing:
that catalog installs npm/git packages as extensions, this page installs a
`SKILL.md` directory.

## Registries

| Source | Base | List | Search | Detail | Files | File body |
| --- | --- | --- | --- | --- | --- | --- |
| clawhub | `https://clawhub.ai` | `GET /api/v1/skills?limit=&cursor=&sort=downloads` | `GET /api/v1/search?q=` (no paging) | `GET /api/v1/skills/{slug}?owner=` | `GET /api/v1/skills/{slug}/versions/{v}?owner=` | `GET /api/v1/skills/{slug}/file?path=&owner=` |
| skillhub | `https://api.skillhub.cn` | `GET /api/skills?page=&pageSize=` | same endpoint with `keyword=` | `GET /api/v1/skills/{slug}` | `GET /api/v1/skills/{slug}/files` | `GET /api/v1/skills/{slug}/file?path=` (302 → COS) |

- **clawhub slugs are not unique across owners.** A read without `owner` answers
  `409 AMBIGUOUS_SKILL_SLUG`, so every list/search result carries an owner and the
  detail/file/install calls pass it back. A pinned owner that still 409s is an
  error, never widened to another owner.
- Overrides for tests and self-hosted mirrors: `PI_MARKET_BASE_CLAWHUB`,
  `PI_MARKET_BASE_SKILLHUB`, `PI_MARKET_DISABLE_PROVIDERS=clawhub,skillhub`.
- skillhub has no description body on its detail endpoint, so the detail page
  fetches `SKILL.md` separately for the overview tab.

## Server modules (`lib/skill-market/`)

- `types.ts` — the normalized shapes both providers project into, the install
  limits (5 MB per file / 20 MB total / 200 files), the slug and owner patterns,
  `sanitizeDirName()` and `parseSkillId()`.
- `provider-fetch.ts` — 10 s timeout, one retry (network errors and 5xx/429 only),
  a response-body cap, and per-source health recorded on `globalThis` so it
  survives a hot reload.
- `clawhub-provider.ts` / `skillhub-provider.ts` — one per registry; each only
  knows its own wire format.
- `market-service.ts` — merge + cache. Two sources are interleaved (so neither
  fills a page alone), deduped per source by slug (**never across sources**:
  the same slug can be different content), paged with an opaque base64url cursor
  carrying each source's own next cursor, and searched with one concurrent call
  per source (both registries' search has no paging). A TTL cache (5 min, capped
  at 200 entries, on `globalThis`) holds details; a source that fails only
  removes its own results and is reported in `sourceErrors`.
- `install-service.ts` — the only writer.

## Install / uninstall

Target: `<agentDir>/skills/<source>-<slug>/` — `~/.pi/agent/skills/...`, the
root `DefaultResourceLoader` already scans, so a new session picks the skill up
with no extra configuration. Opened sessions do **not** reload their tool/skill
table; the page says so after installing.

1. Fetch the detail and file list; refuse when empty, over the count/size caps,
   or when any relative path is absolute, contains `..`, NUL, or is over 512 chars.
2. Download every file into `<skills>/.install-<uuid>/skill/`, verifying each
   against the registry's `sha256` when it provides one.
3. Write `.market-meta.json` (source, slug, owner, version, timestamp, file count).
4. Swap in atomically: existing directory → `<name>.old-<uuid>`, then rename the
   temp dir into place (falling back to copy+rm on `EXDEV`, which Windows hits);
   the backup is deleted on success and restored on failure.

**Uninstall refuses any directory without `.market-meta.json`**, so a skill the
user placed there by hand is never deleted through this route. One install per
slug at a time is enforced in-process (409 `install-in-progress`).

## Routes (`app/api/market/`)

| Route | Method | Notes |
| --- | --- | --- |
| `/api/market/skills` | GET | list or search (`q`), `cursor`, `limit`, `source`, `installed=1` |
| `/api/market/skills/[id]` | GET | `id` = `<source>:<slug>`, `owner` query; detail + install state |
| `/api/market/skills/[id]/file` | GET | `path` + `owner`; preview, truncated past 300 KB |
| `/api/market/installed` | GET | marker-scanned list + skill root |
| `/api/market/install` | POST | `{ id, owner? }` installs; `{ id, action: "uninstall" }` removes |

The write route goes through `isApiRequestAllowed()` + `hasJsonContentType()`
like every other write. The client never supplies a destination path: the body
carries only an id and an owner, and the directory name is derived server-side
from `sanitizeDirName()`.

## UI (`components/skill-market/`)

`SkillMarketView` (page: tabs browse/installed, debounced search, source filter,
card grid, cursor "load more") → `SkillMarketCard` (one card) and
`SkillMarketDetail` (overview / files / security tabs, install confirm dialog
that names source, author, version, size and scan verdict before the button).
`MarketSidebarRow` is the sidebar entry; it sits where the removed Teams row
used to be (the team workbench is reached from the in-session header strip, as
in cc-haha).

All fork CSS lives in `app/native-theme.css` under the "Skill market" section;
`app/globals.css` and `app/settings.css` stay byte-identical to upstream.

## What is deliberately not here

- No curated/featured catalog snapshot (cc-haha ships one); the list is whatever
  the registries serve, sorted by downloads.
- No cross-source dedupe: skillhub mirrors some clawhub skills, and the mirrored
  copy's file set can differ, so both appear and the card names its source.
- No plugin (extension package) installation here; that stays in Settings ›
  Plugins with the `pi-extensions` catalog.