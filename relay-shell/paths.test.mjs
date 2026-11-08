import assert from "node:assert/strict";
import test from "node:test";

const { safeAppPath } = await import("./paths.ts");

test("the shell frames only app pages from outside input", () => {
  for (const ok of ["/", "/?session=abc", "/?view=tasks"]) assert.equal(safeAppPath(ok), ok);
  for (const bad of ["/api/agent/x/events", "/api/auth/login/x", "//evil.example/", "/\\evil.example", "/__shell/", "https://evil.example/", "", null, 5, "/?x=\\y"]) {
    assert.equal(safeAppPath(bad), "/", String(bad));
  }
});

test("app pages and their queries are framed; every non-page shape falls back", () => {
  // The point of the whitelist: a notification or deep link lands on the page
  // it announces instead of the home screen.
  for (const ok of [
    "/",
    "/?session=abc",
    "/?view=tasks",
    "/sessions",
    "/sessions/abc?leafId=xyz",
    "/files/Documents/report.md",
    "/scheduled",
    "/artifacts?q=test",
  ]) {
    assert.equal(safeAppPath(ok), ok, String(ok));
  }
});

test("owner-authority GET endpoints and shell files are never framed", () => {
  for (const bad of [
    "/api/agent/x/events",
    "/api/auth/login/x",
    "/api/sessions/abc/export",
    "/api/",
    "/API/agent/x",
    "/login",
    "/login?next=/",
    "/__shell/",
    "/__shell/shell.js",
    "/__shell/shell-0123456789ab.js",
    "/tunnel-sw.js",
    "/favicon.ico",
  ]) {
    assert.equal(safeAppPath(bad), "/", String(bad));
  }
});

test("path shapes that could smuggle a URL or traversal fall back", () => {
  for (const bad of [
    "//evil.example/",
    "/\\evil.example",
    "https://evil.example/",
    "javascript:alert(1)",
    "/..%2fapi/x",
    "/api%2fagent",
    "/a/../api/x",
    "/..",
    "/%2e%2e/api",
    "/?x=\\y",
    "",
    null,
    5,
    undefined,
  ]) {
    assert.equal(safeAppPath(bad), "/", String(bad));
  }
});

test("URL-normalization escapes are refused, not normalized", () => {
  // WHATWG URL parsing strips tab/LF/CR: the browser would request
  // /api/sessions/x/export for the first two — a framed GET with the owner's
  // authority that bypasses the desktop's user-initiated guard.
  for (const bad of ["/ap\ni/sessions/x/export", "/ap\ti/sessions/x/export", "/api\n"]) {
    assert.equal(safeAppPath(bad), "/", JSON.stringify(bad));
  }
  // Next decodes the pathname before routing, so %61pi arrives as /api.
  // Only query values legitimately carry %XX — a leafId query stays allowed.
  for (const bad of ["/%61pi/...", "/%41pi/x", "/%2f", "/sessions/%2e%2e/x"]) {
    assert.equal(safeAppPath(bad), "/", JSON.stringify(bad));
  }
  assert.equal(safeAppPath("/sessions/abc?leafId=xyz%20a"), "/sessions/abc?leafId=xyz%20a");
});
