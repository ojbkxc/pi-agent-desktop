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
