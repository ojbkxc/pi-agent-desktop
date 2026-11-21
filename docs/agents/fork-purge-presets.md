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
- **Nothing here bypasses anything automatically.** Applying a preset by hand is a
  deliberate operator click; the data plane (`lib/purge/governance.ts`) still
  runs only the rules the console has enabled, and the master switch off is still
  plain passthrough.
- **Auto-apply is on by default, but still gated.** `auto_preset` ships **on**:
  each request looks up the preset whose target model matches the session's own
  model and puts that body on the system prompt (see
  [按模型自动套用](#按模型自动套用auto_preset)). The console's master switch
  `enabled` is **on by default as well** (`defaultPurgeSettings()`), so a fresh
  install is live; turning the master switch off is still a byte-for-byte
  passthrough. No match applies nothing: the resolver never substitutes a
  near-miss, and `vendor` fallback is a separate explicit choice.
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
| `/api/purge/auto-preset` | GET | `{ model, active, mode, match, pinned, preset }` — 只读预览；403 on an untrusted request |

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

## 按模型自动套用（`auto_preset`）

一条会话在跑，模型随时可能被换掉；面板里点一次「设为模板」跟不上这件事。自动套用
把「选错模型就得重配一遍」变成一次开关：请求发出前，服务端按当前会话的模型在目录
里查一次，命中的正文拼到系统提示词上。

### 四个设置字段

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `auto_preset` | `true` | 自动套用开关。默认打开；仍受总闸 `enabled` 约束，总闸关着时数据面是纯转发。 |
| `auto_preset_mode` | `"prepend"` | 预设正文放在宿主提示词**之前**还是之后（`append`）。 |
| `auto_preset_match` | `"exact"` | 只认同名模型；`vendor` 才允许在没有同名预设时退到同厂商第一条。 |
| `auto_preset_id` | `""` | 点名一条预设，优先于模型匹配。指向不存在的 id 时**什么也不套**。 |

`auto_preset_mode` 只有两档，没有「替换」：预设本身是一整份 system prompt，替换会把
工具说明、项目指令一起抹掉。`auto_preset_match` 默认 `exact`，因为把写给别的模型的
prompt 悄悄塞进请求，比套不上更糟。

### 两个模块，一条单向依赖

```
preset-match.ts   查询层：模型 → 匹配强度（纯字符串比较，无动作）
     └─ auto-apply.ts   执行层：开关 → 命中的正文 → 拼进提示词
          └─ extension.ts  before_agent_start 里调用，先治理宿主提示词，再拼正文
```

- `resolveAutoPreset(catalog, settings, model)` 是纯函数：不读盘、不联网、不写设置。
  顺序固定为「固定 id → 同名模型 → （可选）同厂商」，且候选顺序就是目录原序，
  所以同一个模型每次命中的是同一条。
- `composeAutoPreset(host, body, mode)` 负责拼接：空正文不动宿主、空宿主只发正文、
  宿主里已含这段正文时不重复拼接（同一轮多次请求保持幂等）。
- **执行顺序是刻意的**：`system_normalize` / 死区词改写只作用在宿主提示词上，预设
  正文随后原样拼接。词表因此永远不会把第三方 prompt 改写成另一个版本。

### 模型标识从哪来

`before_agent_start` 的事件里没有模型字段，所以 `createPurgeExtension({ readModel })`
注入一个**每次调用现读**的函数；`lib/rpc-manager.ts` 用一个会话 ref 提供
`session.model?.id`（模型可以在会话中途切换，构造时的快照会过期）。拿不到标识时
自动套用不生效，其余治理照常。

### 可观测与预览

- 计数器 `auto_preset_hits`：真的改写了系统提示词的次数（面板「只读统计」里可见）。
- `GET /api/purge/auto-preset`：`{ model, active, mode, match, pinned, preset }`，用本机
  默认模型回答，面板据此渲染一行「默认模型 X → Y」。它只是提示，不参与任何判定。

## Tests

| File | Covers |
| --- | --- |
| `lib/purge/preset-catalog.test.mjs` | 53 entries, unique safe ids, sort order, sha256/bytes self-consistency, LF-only bodies, tag vocabulary, asset/catalog agreement, `--check` exit 0 |
| `lib/purge/presets.test.mjs` | search, vendor facet, `total` vs `limit`, code-point-safe preview, detail hit/miss, both apply targets, unsafe id rejection |
| `lib/purge/governance.test.mjs`, `lib/purge-settings.test.mjs` | the template-aware structured suffix and the tolerant settings normalization |
| `app/api/purge/presets/**/*.test.mjs` | the three routes, every gate, and the cross-boundary apply contract |
| `components/PurgePresetLibrary.test.mjs` | first paint, debounced search, vendor chips, preview, the three actions, permanent notice, three-locale key parity |
| `lib/purge/auto-apply.test.mjs` | 开关优先级、exact / vendor / manual 解析、空模型不猜、拼接与幂等、真实目录不会把 deepseek 的预设给 qwen |
| `lib/purge/extension.test.mjs` | 前插 / 后附、关闭与无标识时零改动、vendor 兜底只在显式选择时发生、固定 id、正文不被词表改写、`auto_preset_hits` 计数 |
| `app/api/purge/auto-preset/route.test.mjs` | 预览载荷、模型缺失时的 null、403 与 `no-store` |
| `components/PurgeConsoleSection.test.mjs` | 自动套用开关与两组枚举控件、载荷顺序、统计行、三语键齐全 |

## Files

`scripts/sync-purge-presets.mjs`, `assets/purge-presets/**`,
`lib/purge/preset-catalog.ts`, `lib/purge/presets.ts`,
`lib/purge/preset-match.ts`, `lib/purge/auto-apply.ts`,
`app/api/purge/presets/**`, `app/api/purge/auto-preset/route.ts`,
`components/PurgePresetLibrary.tsx`, `components/PurgeConsoleSection.tsx`.
