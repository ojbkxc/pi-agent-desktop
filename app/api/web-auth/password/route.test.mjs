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
const { PUT, DELETE } = await jiti.import("./route.ts");
const { createWebSessionToken, isValidWebSessionToken } = await jiti.import("../../../../lib/web-auth.ts");
const { readWebPasswordRecord } = await jiti.import("../../../../lib/web-password-store.ts");
const { recordAuthSuccess } = await import("../../../../lib/auth-throttle.ts");

const dir = mkdtempSync(join(tmpdir(), "pi-web-auth-password-"));
before(() => {
  delete process.env.PI_WEB_PASSWORD;
  process.env.PI_CODING_AGENT_DIR = dir;
});
beforeEach(() => { recordAuthSuccess(); });
after(() => {
  recordAuthSuccess();
  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(dir, { recursive: true, force: true });
});

function request(method, body, headers = {}) {
  return new NextRequest("http://localhost/api/web-auth/password", {
    method,
    headers: {
      Host: "localhost",
      Origin: "http://localhost",
      "Sec-Fetch-Site": "same-origin",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("sets the first password without a current password, from this computer only", async () => {
  let response = await PUT(request("PUT", { newPassword: "first-secret" }, { "X-Forwarded-For": "8.8.8.8" }));
  assert.equal(response.status, 403, "非本机请求一律拒绝");
  assert.equal(response.headers.has("set-cookie"), false);

  response = await PUT(request("PUT", { newPassword: "first-secret" }));
  assert.equal(response.status, 200);
  const record = readWebPasswordRecord();
  assert.ok(record, "密码以 scrypt 记录落盘");
  assert.notEqual(record.hash, "first-secret", "绝不存明文");
  assert.match(record.salt, /^[0-9a-f]{64}$/);
  assert.match(record.hash, /^[0-9a-f]{128}$/);

  // 响应里带新签发的会话 cookie，旧的无 cookie 客户端需要重新登录。
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /^pi_web_session=v1\./);
  const token = cookie.split(";", 1)[0].split("=", 2)[1];
  assert.equal(isValidWebSessionToken(token), true);
});

test("changing the password needs the current one and invalidates old sessions", async () => {
  // 用旧密码签发的会话 token：改密后必须失效。
  const oldToken = createWebSessionToken();

  let response = await PUT(request("PUT", { currentPassword: "wrong", newPassword: "second-secret" }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "invalid-current");
  assert.equal(response.headers.has("set-cookie"), false, "失败不签发会话");

  recordAuthSuccess();
  response = await PUT(request("PUT", { currentPassword: "first-secret", newPassword: "second-secret" }));
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  const newToken = cookie.split(";", 1)[0].split("=", 2)[1];
  assert.equal(isValidWebSessionToken(newToken), true, "当前浏览器换发新会话");
  assert.equal(isValidWebSessionToken(oldToken), false, "旧签名密钥随 hash 轮换失效");
});

test("wrong current-password attempts share the login throttle", async () => {
  const response = await PUT(request("PUT", { currentPassword: "nope", newPassword: "third-secret" }));
  assert.equal(response.status, 401);
  // 上一条失败刚把计数抬起来：紧跟着的正确密码在节流窗口内也会被拒。
  const blocked = await PUT(request("PUT", { currentPassword: "second-secret", newPassword: "third-secret" }));
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  recordAuthSuccess();
});

test("env-sourced passwords refuse edits and clearing", async () => {
  process.env.PI_WEB_PASSWORD = "env-secret";
  try {
    let response = await PUT(request("PUT", { currentPassword: "env-secret", newPassword: "x-secret" }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "managed-by-env");

    response = await DELETE(request("DELETE"));
    assert.equal(response.status, 409);
  } finally {
    delete process.env.PI_WEB_PASSWORD;
  }
});

test("clearing removes the record and clears the session cookie", async () => {
  const response = await DELETE(request("DELETE"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /pi_web_session=;/);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/i);
  assert.equal(readWebPasswordRecord(), null);

  // 幂等：再关一次也 200。
  const again = await DELETE(request("DELETE"));
  assert.equal(again.status, 200);
});

test("rejects malformed bodies and non-local callers", async () => {
  let response = await PUT(request("PUT", { newPassword: "" }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "invalid-new");

  response = await PUT(request("PUT", { newPassword: "x".repeat(1025) }));
  assert.equal(response.status, 400);

  response = await PUT(request("PUT", undefined, { "X-Forwarded-For": "8.8.8.8" }));
  assert.equal(response.status, 403);

  response = await DELETE(request("DELETE", undefined, { "X-Forwarded-For": "8.8.8.8" }));
  assert.equal(response.status, 403);
});
