import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ServerSection.tsx", import.meta.url), "utf8");

test("tunnel status polling resumes when the tab becomes visible again", () => {
  // The setTimeout chain skips its tick (and with it the only continuation)
  // while hidden; the visibilitychange listener is the resume path.
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibility\)/);
  assert.match(source, /document\.removeEventListener\("visibilitychange", onVisibility\)/);
  assert.match(source, /lastLive && !timer\) void load\(\);/);
});

test("every tunnel error kind maps to an actionable hint (including the new proxy kind)", () => {
  // The hint switch must cover each error the server can report. A missing arm
  // leaves the user with the bare status line, which is the reported bug.
  for (const kind of ["token", "route", "proxy", "network", "configuration", "runtime", "stop"]) {
    assert.match(source, new RegExp(`t\\("publicAccess\\.hint\\.${kind}"`), `missing hint for ${kind}`);
  }
  // The route hint must carry the actual listening port — that is the value the
  // Cloudflare ingress rule has to point at.
  assert.match(source, /t\("publicAccess\.hint\.route", \{ port: view\.localPort \}\)/);
  // `proxy` has to be part of the error union, or the switch arm is unreachable.
  assert.match(source, /error: "network" \| "configuration" \| "token" \| "route" \| "runtime" \| "stop" \| "proxy" \| null/);
});

test("the port hint labels view.localPort as the actual port", () => {
  assert.match(source, /t\("publicAccess\.hint\.portActual", \{ port: view\.localPort \}\)/);
});

test("diagnostics are optional: missing field renders nothing and never crashes", () => {
  // Contract not yet delivered by the server: the field is optional and every
  // read goes through the shape-guarding parser / nullish fallback.
  assert.match(source, /diagnostics\?: PublicAccessDiagnosticEntry\[\] \| null/);
  assert.match(source, /const diagnostics = parseDiagnostics\(view\?\.diagnostics\)/);
  assert.match(source, /diagnostics\.length > 0 &&/);
  assert.match(source, /function parseDiagnostics\(value: unknown\): PublicAccessDiagnosticEntry\[\]/);
  // Entries render in buffer order, failures highlighted, durations shown.
  assert.match(source, /diagnostics\.map\(\(entry, index\) =>/);
  assert.match(source, /entry\.outcome === "failed" \? " is-failed" : ""/);
  assert.match(source, /formatDuration\(entry\.durationMs\)/);
});

test("self-check button posts to the diagnose route and is local-only + not re-entrant", () => {
  assert.match(source, /fetch\("\/api\/public-access\/diagnose", \{ method: "POST", cache: "no-store" \}\)/);
  assert.match(source, /disabled=\{!publicAccess\?\.local \|\| diagnosing\}/);
  assert.match(source, /t\("publicAccess\.diag\.check"\)/);
  assert.match(source, /t\("publicAccess\.diag\.checking"\)/);
  // Server results are shape-checked before rendering.
  assert.match(source, /function parseDiagnoseChecks\(value: unknown\): DiagnoseCheck\[\]/);
});

test("domain binding wizard keeps guiding while routes are still being pushed", () => {
  // Before the first route push arrives domainBinding is null; the wizard used to
  // disappear entirely instead of telling the user it is still waiting.
  assert.match(source, /view\.state === "connecting" \|\| view\.state === "reconnecting" \|\| view\.state === "online"/);
  for (const state of ["polling", "bound", "unbound", "timeout"]) {
    assert.match(source, new RegExp(`case "${state}":`), `missing binding arm ${state}`);
  }
  assert.match(source, /t\("publicAccess\.binding\.unboundOther", \{ hostname, port: view\.localPort \}\)/);
  assert.match(source, /t\("publicAccess\.binding\.unboundService", \{ hostname \}\)/);
});

// state.md / interaction.md P2：复制反馈的裸 setTimeout 不保存句柄、失败无提示。
// 统一走共享 useCopyFeedback（失败显示 i18n.copyFailed，连点不互踩）。
test("the public URL copy uses the shared copy-feedback hook", () => {
  assert.match(source, /import \{ useCopyFeedback \} from "@\/hooks\/useCopyFeedback"/);
  assert.match(source, /const \{ copied, failed: copyFailed, copy \} = useCopyFeedback\(\)/);
  assert.match(source, /void copy\(view\.publicUrl!\)/);
  assert.match(source, /t\("i18n\.copyFailed"\)/);
  assert.doesNotMatch(source, /setCopied/);
});

// interaction.md P1：「关闭密码」与「撤销已配对手机」过去一击即生效，而 DELETE
// 路由只校验本机请求、不要求当前密码。两处改为先过 ChatConfirmDialog（默认焦点
// 不落在危险按钮上），确认后才发删除请求。
test("password removal and phone revocation confirm before deleting", () => {
  assert.match(source, /import \{ ChatConfirmDialog \} from "\.\/ChatConfirmDialog"/);
  assert.match(source, /const \[clearPasswordOpen, setClearPasswordOpen\] = useState\(false\);/);
  assert.match(source, /const \[revokeTarget, setRevokeTarget\] = useState<\{ id: string; name: string \} \| null>\(null\);/);
  // The buttons only open the dialog…
  assert.match(source, /onClick=\{\(\) => setClearPasswordOpen\(true\)\}/);
  assert.match(source, /onClick=\{\(\) => setRevokeTarget\(\{ id: device\.id, name: device\.name \}\)\}/);
  // …and the DELETE runs only from the confirm handler.
  assert.match(source, /onConfirm=\{\(\) => \{ void clearPassword\(\)\.then\(\(ok\) => \{ if \(ok\) setClearPasswordOpen\(false\); \}\); \}\}/);
  assert.match(source, /onConfirm=\{\(\) => \{ void revokePhone\(revokeTarget\.id\)\.then\(\(ok\) => \{ if \(ok\) setRevokeTarget\(null\); \}\); \}\}/);
  assert.match(source, /busy=\{pwBusy\}/);
  assert.match(source, /busy=\{pairingBusy\}/);
  // Portaled out of the transformed settings surface, so the confirm layer is viewport-sized.
  assert.match(source, /createPortal\(\s*<ChatConfirmDialog/);
});
