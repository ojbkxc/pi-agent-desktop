# Optional red-team skill pack

A bundled, **opt-in** pack of 23 security-testing skills vendored verbatim from
[`kingcharleslzy-ai/dsh-purge`](https://github.com/kingcharleslzy-ai/dsh-purge)
(`skills/redteam/`, commit `e519253d…`, version 1.7.20, MIT). It is **not** part
of `builtin-skills/` and is never auto-loaded.

## Why it is not auto-loaded

`builtin-skills/` is handed to every session through `additionalForkSkillPaths()`
(`lib/fork-skill-paths.ts`). The red-team pack must stay off by default: its
content is offensive security playbooks (recon, asset mapping, vulnerability
checks, lateral movement, WebShell/tunnels). Installing is an explicit operator
action on the Skills panel, and the permanent notice there states the authorized-
use boundary.

## Flow

```
optional-skills/redteam/*.md          (vendored, 23 files, LF)
  └─ scripts/prepare-desktop.mjs      stages it to resources/server/optional-skills/
       └─ lib/redteam-skills.ts       read / install / status / uninstall
            └─ app/api/skills/redteam route (GET status, POST install|uninstall)
                 └─ components/RedteamSkillPackRow.tsx
                      └─ components/SkillsConfig.tsx  (Settings › Skills)
```

Install copies each `*.md` to `<agent dir>/skills/redteam/<name>/SKILL.md` and
writes `.redteam-pack.json` (source, commit, names). The SDK's default user skill
root is `<agent dir>/skills`, so the next skill scan picks them up — the same
list `GET /api/skills` shows. Uninstall deletes **only** the names recorded in
the marker; a directory without the marker is refused (`409 not-a-pack`) so a
user's own `skills/redteam/my-skill` is never removed. The container directory is
removed only when it is left empty.

## Verbatim rule

Files are copied from upstream without edits; the only transformation is
CRLF → LF, and `.gitattributes` pins `optional-skills/** text eol=lf` so a
Windows checkout stays byte-identical. `LICENSE` and `NOTICE.md` ship in the pack
directory for attribution; `readRedteamPack()` skips them because they have no
skill frontmatter.

## Updating

```bash
git clone --depth 1 https://github.com/kingcharleslzy-ai/dsh-purge.git /tmp/dsh-purge
rm -f optional-skills/redteam/*.md
cp /tmp/dsh-purge/skills/redteam/*.md optional-skills/redteam/
# normalize LF, then update REDTEAM_PACK_COMMIT / REDTEAM_PACK_VERSION in lib/redteam-skills.ts
node --test lib/redteam-skills.test.mjs scripts/prepare-desktop-optional-skills.test.mjs
```

## Files

`optional-skills/README.md`, `optional-skills/redteam/**`, `lib/redteam-skills.ts`,
`app/api/skills/redteam/route.ts`, `components/RedteamSkillPackRow.tsx`,
`components/SkillsConfig.tsx` (import), `scripts/prepare-desktop.mjs` (stage),
`lib/redteam-skills.test.mjs`, `app/api/skills/redteam/route.test.mjs`,
`scripts/prepare-desktop-optional-skills.test.mjs`.

## Boundaries

- The pack is data only. Nothing here executes a skill; the model decides whether
  to use one, and the operator is responsible for authorization.
- No host patches, installers, auto-updaters, or safety-gate changes were taken
  from upstream — only `skills/redteam/` was vendored.
- This is deliberately separate from the Purge console
  (`docs/agents/fork-purge-presets.md`), which governs outgoing request text.
