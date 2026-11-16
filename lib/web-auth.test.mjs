import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadSubject() {
  return import("./web-auth.ts");
}

function authorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

/** 双来源用例的隔离脚手架：清 env 密码 + PI_CODING_AGENT_DIR 指向空临时目录。 */
async function withStoredSource(run) {
  const { writeWebPasswordRecord, clearWebPasswordRecord } = await import("./web-password-store.ts");
  const dir = mkdtempSync(join(tmpdir(), "pi-web-auth-dual-"));
  const previousPassword = process.env.PI_WEB_PASSWORD;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    delete process.env.PI_WEB_PASSWORD;
    process.env.PI_CODING_AGENT_DIR = dir;
    return await run({ writeWebPasswordRecord, clearWebPasswordRecord, dir });
  } finally {
    clearWebPasswordRecord();
    if (previousPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previousPassword;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("enables password authentication only for a non-empty configured password", async () => {
  const { isWebPasswordEnabled } = await loadSubject();
  assert.equal(isWebPasswordEnabled(undefined), false);
  assert.equal(isWebPasswordEnabled(""), false);
  assert.equal(isWebPasswordEnabled("secret"), true);
});

test("the password is the only credential; the Basic username is ignored", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  assert.equal(isValidBasicAuthorization(authorization("pi", "secret"), "secret"), true);
  // 不再是固定用户名——浏览器不会再弹「用户名 + 密码」的原生框，API 客户端也
  // 不必知道某个约定用户名。
  assert.equal(isValidBasicAuthorization(authorization("admin", "secret"), "secret"), true);
  assert.equal(isValidBasicAuthorization(authorization("", "secret"), "secret"), true);
  assert.equal(isValidBasicAuthorization(authorization("pi", "wrong"), "secret"), false);
});

test("supports UTF-8 passwords and colons in the password", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  const password = "口令:with:colons";
  assert.equal(isValidBasicAuthorization(authorization("pi", password), password), true);
});

test("rejects missing, malformed, and non-canonical authorization values", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  const valid = authorization("pi", "secret");

  assert.equal(isValidBasicAuthorization(null, "secret"), false);
  assert.equal(isValidBasicAuthorization("Bearer token", "secret"), false);
  assert.equal(isValidBasicAuthorization("Basic !!!", "secret"), false);
  assert.equal(isValidBasicAuthorization(`${valid}!`, "secret"), false);
  assert.equal(isValidBasicAuthorization(
    `Basic ${Buffer.from("missing-separator", "utf8").toString("base64")}`,
    "secret",
  ), false);
});

test("does not authenticate when password protection is disabled", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  assert.equal(isValidBasicAuthorization(authorization("pi", ""), ""), false);
  assert.equal(isValidBasicAuthorization(authorization("pi", "secret"), undefined), false);
});

test("creates signed sessions that expire and cannot be altered", async () => {
  const {
    createWebSessionToken,
    isValidWebSessionToken,
    PI_WEB_SESSION_MAX_AGE,
  } = await loadSubject();
  const now = Date.UTC(2026, 8, 7);
  const token = createWebSessionToken("secret", now, "a".repeat(32));

  assert.equal(isValidWebSessionToken(token, "secret", now), true);
  assert.equal(isValidWebSessionToken(token, "wrong", now), false);
  assert.equal(isValidWebSessionToken(`${token.slice(0, -1)}0`, "secret", now), false);
  assert.equal(isValidWebSessionToken(token, "secret", now + PI_WEB_SESSION_MAX_AGE * 1000), false);
});

// ——— 双来源：env `PI_WEB_PASSWORD` + 设置文件里的 scrypt 记录（lib/web-password-store.ts）———

test("a settings-file record enables password auth when the env variable is unset", async () => {
  const { isWebPasswordEnabled, isValidWebPassword, webPasswordSource, isWebPasswordSourceActive } = await loadSubject();
  await withStoredSource(async ({ writeWebPasswordRecord }) => {
    assert.equal(isWebPasswordEnabled(), false);
    assert.equal(webPasswordSource(), null);
    assert.equal(isWebPasswordSourceActive(), false);
    assert.equal(isValidWebPassword("anything"), false, "两处都没有来源时一律拒绝");

    writeWebPasswordRecord("stored-secret");
    assert.equal(isWebPasswordEnabled(), true);
    assert.equal(isWebPasswordSourceActive(), true);
    assert.equal(webPasswordSource(), "stored");
    assert.equal(isValidWebPassword("stored-secret"), true, "scrypt hash 校验");
    assert.equal(isValidWebPassword("wrong"), false);
  });
});

test("the env variable shadows a stored record", async () => {
  const { isValidWebPassword, webPasswordSource } = await loadSubject();
  await withStoredSource(async ({ writeWebPasswordRecord }) => {
    writeWebPasswordRecord("stored-secret");
    process.env.PI_WEB_PASSWORD = "env-secret";
    assert.equal(webPasswordSource(), "env");
    assert.equal(isValidWebPassword("env-secret"), true);
    assert.equal(isValidWebPassword("stored-secret"), false, "env 优先时存储来源完全遮蔽");
  });
});

test("Basic authorization verifies against the stored record without an explicit password", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  await withStoredSource(async ({ writeWebPasswordRecord }) => {
    writeWebPasswordRecord("stored-secret");
    assert.equal(isValidBasicAuthorization(authorization("pi", "stored-secret")), true);
    assert.equal(isValidBasicAuthorization(authorization("admin", "stored-secret")), true);
    assert.equal(isValidBasicAuthorization(authorization("pi", "wrong")), false);
    assert.equal(isValidBasicAuthorization(null), false);
  });
});

test("changing the stored password invalidates sessions minted for the old hash", async () => {
  const { createWebSessionToken, isValidWebSessionToken } = await loadSubject();
  await withStoredSource(async ({ writeWebPasswordRecord }) => {
    writeWebPasswordRecord("first-secret");
    const oldToken = createWebSessionToken();
    assert.equal(isValidWebSessionToken(oldToken), true);

    // 改密轮换存储的 hash（它是会话签名的 HMAC 密钥）→ 旧 token 全部失效。
    writeWebPasswordRecord("second-secret");
    assert.equal(isValidWebSessionToken(oldToken), false);
    assert.equal(isValidWebSessionToken(createWebSessionToken()), true);
  });
});

test("an env-source token stops working once only the stored source remains", async () => {
  const { createWebSessionToken, isValidWebSessionToken } = await loadSubject();
  await withStoredSource(async ({ writeWebPasswordRecord }) => {
    process.env.PI_WEB_PASSWORD = "env-secret";
    const envToken = createWebSessionToken();
    assert.equal(isValidWebSessionToken(envToken), true);

    delete process.env.PI_WEB_PASSWORD;
    writeWebPasswordRecord("stored-secret");
    assert.equal(isValidWebSessionToken(envToken), false, "来源切换后旧签名密钥不再可信");
    assert.equal(isValidWebSessionToken(createWebSessionToken()), true);
  });
});

test("creating a token without any configured password throws", async () => {
  const { createWebSessionToken } = await loadSubject();
  await withStoredSource(async () => {
    assert.throws(() => createWebSessionToken(), /No web password is configured/);
  });
});

test("explicit-argument calls keep the env-only semantics", async () => {
  const { isWebPasswordEnabled, isValidWebPassword } = await loadSubject();
  await withStoredSource(async ({ writeWebPasswordRecord }) => {
    writeWebPasswordRecord("stored-secret");
    // 显式传参 = 旧语义，只看传入值，不读设置文件。
    assert.equal(isWebPasswordEnabled(undefined), false);
    assert.equal(isWebPasswordEnabled("secret"), true);
    assert.equal(isValidWebPassword("stored-secret", "other"), false);
    assert.equal(isValidWebPassword("other", "other"), true);
  });
});
