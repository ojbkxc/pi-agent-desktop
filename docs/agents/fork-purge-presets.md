# Purge preset library (fork)

A preset library inside Settings › Purge: 53 third-party prompt files vendored
verbatim, searchable by keyword and vendor, with three actions — set one as the
structured template, copy its text, or write it into the skill directory.
Fork-owned end to end; nothing here is upstream pi-web.

## Where the text comes from, and the compliance boundary

The 53 bodies are a sibling checkout of a public **jailbreaks** collection: a
curated set of system prompts, persona locks, workspace policies and agent
operating specifications. They are copied **verbatim** — nothing is filtered,
rewritten, reflowed or truncated, because a silently edited preset is worse than
no preset: the operator can no longer tell what they are actually sending.

53 = 52 non-empty `.md` + 1 `.txt` (`xAI/grok-config.txt`, a `<CFG>` routing
config the upstream README lists as its own entry). Two files are excluded: the
collection's root `README.md`, and `Alibaba/qwen-preferences.md`, which is a
2-byte (empty) file upstream. The generator names the skipped file on stderr so
the omission is visible rather than silent.

The boundary the panel states and keeps:

- **Authorized defensive security assessment only.** The notice sits in the panel
  as permanent text, not a dismissible toast — an operator who scrolls past it
  cannot claim they were not told.
- **Nothing here bypasses anything automatically.** Applying a preset is a
  deliberate operator click; the data plane (`lib/purge/governance.ts`) still
  runs only the rules the console has enabled, and the master switch off is still
  plain passthrough.
- **Compliance is the operator's.** The app ships the transport and the wording,
  not a judgement about whether a given use is authorized.

## Data flow

```
<checkout>/jailbreaks/*.md|*.txt
  └─ scripts/sync-purge-presets.mjs        CRLF→LF, UTF-8, sha256, skip empty
       ├─ assets/purge-presets/<vendor>/<id>.md      53 files, diffable
       └─ lib/purge/preset-catalog.ts                bodies inlined (generated)
            └─ lib/purge/presets.ts                   search / detail / apply
                 └─ app/api/purge/presets/**          three routes
                      └─ components/PurgePresetLibrary.tsx
                           └─ components/PurgeConsoleSection.tsx  (Settings › Purge)
```

The catalog is inlined as string constants rather than read from disk at
runtime, so the packaged desktop app needs no extra file resolution and the
server reads presets from memory. Same pattern as `lib/skill-market/catalog.ts`.

### Generator and its idempotency gate

```bash
node scripts/sync-purge-presets.mjs           # rebuild assets + catalog
node scripts/sync-purge-presets.mjs --check   # exit 0 when the tree matches
```

`PURGE_PRESETS_SOURCE` overrides the source directory (default
`D:/GitHub/jailbreaks`). The output is deterministic: bodies normalized to LF, ids
derived as `<vendor>-<model>` with non-alphanumerics folded to `-`, entries sorted
by `(vendor, model, id)`, no timestamps, and the asset directory rebuilt from
scratch. `--check` recomputes everything in memory and reports drift, so CI can
gate on it.

`.gitattributes` pins `assets/purge-presets/**` and `lib/purge/preset-catalog.ts`
to `text eol=lf`. Without that, a fresh checkout on Windows (`core.autocrlf=true`)
turns the bodies into CRLF and `--check` reports drift on an otherwise clean tree.

## Search and detail

`lib/purge/presets.ts` is the read layer. `listPresets({ q, vendor, limit })`
returns `{ items, vendors, total }`:

- `q` matches id / vendor / model / title / tags, case-insensitively.
- `vendor` is an exact, case-insensitive match.
- `limit` defaults to 50, caps at 500, and falls back to the default for a
  non-positive or non-numeric value.
- `total` is the match count **before** `limit` truncates `items`, so the panel
  can say "50 of 53".
- `vendors` is counted over the query matches only: it is the vendor facet, so
  narrowing by vendor must not zero out the other chips.
- `preview` is cut by **code points**, not bytes — slicing a surrogate pair would
  produce a broken glyph in the list.

`getPreset(id)` returns the same row plus the full body, or `undefined`.

## The two landing points

| Target | What happens | Persisted? | Takes effect |
| --- | --- | --- | --- |
| `structured_template` | Upserts `{ name: title, text: body }` into `settings.structured_templates` by name, so re-applying is idempotent. `activate: true` also sets `active_template`. | **No** — the server's snapshot only; the console owns its draft and saves it with its own PUT. | On the next save, when `structured_prompt` is on. |
| `skill_file` | Writes `<skill_dir>/<id>/SKILL.md` (frontmatter: `name`, `description`, `keywords` from the tags; body verbatim). | The file only; settings are untouched. | The next skill scan picks it up. |

`active_template` names the template `structured_prompt` appends. An empty string
(or a name that no longer exists) falls back to `structured_suffix` — so deleting
a template can degrade to the plain suffix but never silently drop the append.

The id is whitelisted (`^[a-z0-9]+(-[a-z0-9]+)*$`, ≤128 bytes) before it becomes
a path segment: a preset id is never allowed to walk out of the skill directory.

### The panel's three actions

- **Set as structured template** — a **purely local** upsert into the console's
  draft (`onApplyTemplate` marks the form dirty). It does **not** call
  `POST .../apply`, so the API's `structured_template` landing point is covered by
  the route and contract tests only; the real UI path never reaches it. This is
  deliberate: a clicked preset must never silently overwrite unsaved edits.
- **Copy text** — `GET` the detail, then `navigator.clipboard.writeText`.
- **Write to skill directory** — `POST .../apply { target: "skill_file" }`, then
  report the path the server wrote.

31 `purge.preset*` keys exist in all three locales (`en`, `zh-CN`, `zh-TW`). The
status-line keys are chosen at runtime from the action result, so
`lib/i18n/dynamic-keys.test.mjs` lists them explicitly — a static scan cannot see
them, and a missing translation would render the raw key.

## API

| Route | Method | Answer |
| --- | --- | --- |
| `/api/purge/presets?q=&vendor=&limit=` | GET | `{ items, vendors, total }` |
| `/api/purge/presets/[id]` | GET | `{ preset }` (with the full body), or 404 |
| `/api/purge/presets/[id]/apply` | POST | `{ result: { target, changed, template?, path? }, settings }` |

Apply gates, in order: `isApiRequestAllowed` → 403; `hasJsonContentType` → 415;
unparseable JSON → 400; unknown `target` / non-boolean `activate` → 400; unknown
id → 404; write failure → 500. The 500 never echoes the underlying error, because
it can carry the skill-directory path.

`result.changed` is forwarded from `applyPreset`. `settings` is the post-apply
in-memory snapshot; the panel **ignores** it, since echoing it back would invite a
silent overwrite of unsaved draft edits.

### Why `apply-contract.test.mjs` exists

The route answered `{ result, settings }` while the panel's parser required
`{ applied }`. Both sides had passing tests — each tested its own assumption — so
a **successful** disk write rendered as a failure, and the only symptom was a red
toast over a `SKILL.md` that had in fact been written. That is the worst failure
shape available: the user is told the opposite of what happened.

`app/api/purge/presets/apply-contract.test.mjs` closes the seam: it calls the
real handler and feeds the real JSON to the real parser, asserting that a 200
skill apply reports a path that exists on disk, that a template apply carries the
template name, and that a 404 is not read as success. Reverting the parser to
`{ applied }` makes it fail 2 of 3, so the mismatch cannot come back quietly.

## Tests

| File | Covers |
| --- | --- |
| `lib/purge/preset-catalog.test.mjs` | 53 entries, unique safe ids, sort order, sha256/bytes self-consistency, LF-only bodies, tag vocabulary, asset/catalog agreement, `--check` exit 0 |
| `lib/purge/presets.test.mjs` | search, vendor facet, `total` vs `limit`, code-point-safe preview, detail hit/miss, both apply targets, unsafe id rejection |
| `lib/purge/governance.test.mjs`, `lib/purge-settings.test.mjs` | the template-aware structured suffix and the tolerant settings normalization |
| `app/api/purge/presets/**/*.test.mjs` | the three routes, every gate, and the cross-boundary apply contract |
| `components/PurgePresetLibrary.test.mjs` | first paint, debounced search, vendor chips, preview, the three actions, permanent notice, three-locale key parity |

## Files

`scripts/sync-purge-presets.mjs`, `assets/purge-presets/**`,
`lib/purge/preset-catalog.ts`, `lib/purge/presets.ts`,
`app/api/purge/presets/**`, `components/PurgePresetLibrary.tsx`,
`components/PurgePresetLibrary.test.mjs`.
