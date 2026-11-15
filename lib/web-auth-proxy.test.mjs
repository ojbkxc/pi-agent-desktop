import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalPassword = process.env.PI_WEB_PASSWORD;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { proxy } = await jiti.import("../proxy.ts");
const { createWebSessionToken } = await jiti.import("./web-auth.ts");
const { getAuthRetryAfterMs, recordAuthFailure, recordAuthSuccess } = await import("./auth-throttle.ts");

before(() => { process.env.PI_WEB_PASSWORD = "secret"; });
beforeEach(() => { recordAuthSuccess(); });
after(() => {
  recordAuthSuccess();
  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

function request(path, headers = {}) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { Host: "localhost", ...headers },
  });
}

test("redirects page navigation to the login page and preserves its query", () => {
  const response = proxy(request("/?session=abc"));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/login?next=%2F%3Fsession%3Dabc");
});

test("accepts a signed session for pages", () => {
  const token = createWebSessionToken("secret");
  const response = proxy(request("/", { Cookie: `pi_web_session=${token}` }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("keeps Basic Auth compatibility for APIs but not pages", () => {
  const authorization = `Basic ${Buffer.from("pi:secret").toString("base64")}`;
  assert.equal(proxy(request("/api/sessions", { Authorization: authorization })).status, 200);
  assert.equal(proxy(request("/", { Authorization: authorization })).status, 307);
  assert.equal(proxy(request("/api/sessions")).status, 401);
});

test("leaves the login endpoint reachable without a session", () => {
  assert.equal(proxy(request("/login")).status, 200);
  assert.equal(proxy(request("/api/web-auth")).status, 200);
});

function basic(password) {
  return `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
}

test("a wrong Basic password blocks further attempts, even with the right password", () => {
  assert.equal(proxy(request("/api/sessions", { Authorization: basic("guess") })).status, 401);
  assert.ok(getAuthRetryAfterMs() > 0);

  for (const path of ["/api/sessions", "/api/web-auth"]) {
    const response = proxy(request(path, { Authorization: basic("secret") }));
    assert.equal(response.status, 429, path);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("GET /api/web-auth cannot be used to check Basic passwords without the throttle", () => {
  assert.equal(proxy(request("/api/web-auth", { Authorization: basic("guess") })).status, 200);
  assert.ok(getAuthRetryAfterMs() > 0);
  assert.equal(proxy(request("/api/web-auth", { Authorization: basic("guess-2") })).status, 429);
});

test("a signed session keeps working while Basic attempts are blocked", () => {
  proxy(request("/api/sessions", { Authorization: basic("guess") }));
  const token = createWebSessionToken("secret");
  const response = proxy(request("/api/sessions", {
    Authorization: basic("guess"),
    Cookie: `pi_web_session=${token}`,
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("only Basic credentials count as password attempts", () => {
  assert.equal(proxy(request("/api/sessions", { Authorization: "Bearer token" })).status, 401);
  assert.equal(getAuthRetryAfterMs(), 0);
});

test("a Basic success does not reset earlier failures", () => {
  recordAuthFailure(Date.now() - 2_000);
  assert.equal(getAuthRetryAfterMs(), 0);
  assert.equal(proxy(request("/api/sessions", { Authorization: basic("secret") })).status, 200);

  assert.equal(proxy(request("/api/sessions", { Authorization: basic("guess") })).status, 401);
  // The second failure in a row doubles the block instead of starting over.
  assert.ok(getAuthRetryAfterMs() > 1_000);
});

test("the settings-file record drives the gate while the env variable is unset", async () => {
  const { writeWebPasswordRecord, clearWebPasswordRecord } = await jiti.import("./web-password-store.ts");
  const dir = mkdtempSync(join(tmpdir(), "pi-web-auth-proxy-"));
  try {
    delete process.env.PI_WEB_PASSWORD;
    process.env.PI_CODING_AGENT_DIR = dir;
    recordAuthSuccess();

    // 没有任何来源：门禁放行（未设密码 = 无鉴权的旧行为）。
    assert.equal(proxy(request("/api/sessions")).status, 200);

    writeWebPasswordRecord("stored-secret");
    // 记录来源生效：无凭据要登录页，API 401；Basic 与会话 cookie 都按记录校验。
    assert.equal(proxy(request("/")).status, 307);
    assert.equal(proxy(request("/api/sessions")).status, 401);
    assert.equal(proxy(request("/api/sessions", { Authorization: basic("stored-secret") })).status, 200);
    assert.equal(proxy(request("/api/sessions", { Authorization: basic("secret") })).status, 401, "env 密码不再是有效凭据");
    const token = createWebSessionToken();
    assert.equal(proxy(request("/", { Cookie: `pi_web_session=${token}` })).status, 200);

    clearWebPasswordRecord();
    assert.equal(proxy(request("/")).status, 200, "关闭密码后回到无鉴权");
  } finally {
    clearWebPasswordRecord();
    if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = originalPassword;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(dir, { recursive: true, force: true });
    recordAuthSuccess();
  }
});
