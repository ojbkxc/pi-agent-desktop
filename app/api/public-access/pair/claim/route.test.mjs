import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";

/**
 * POST /api/public-access/pair/claim —— 批准后把设备令牌写进 __Host-pi-remote。
 *
 * 反向断言：令牌明文只出现在 Set-Cookie 里；响应 JSON 与设备表文件都不含它。
 */
const dir = mkdtempSync(join(tmpdir(), "pi-pair-claim-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const route = await jiti.import("./route.ts");
const pairing = await jiti.import("../../../../../lib/public-access/pairing.ts");
const devices = await jiti.import("../../../../../lib/public-access/devices.ts");

const ORIGIN = "https://pi.example.com";
const settingsPath = join(dir, "pi-web", "settings.json");
const storePath = devices.publicAccessDevicesPath();

after(() => {
  pairing.resetPairingForTests();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  pairing.resetPairingForTests();
  rmSync(storePath, { force: true });
  mkdirSync(join(dir, "pi-web"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ publicAccess: { origin: ORIGIN } }));
});

function post(body, { host = "pi.example.com", contentType = "application/json" } = {}) {
  const headers = { host };
  if (contentType) headers["content-type"] = contentType;
  return new Request(`http://${host}/api/public-access/pair/claim`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function pendingPairing() {
  const { secret } = pairing.beginPairing();
  const redeemed = pairing.redeemPairingSecret({ secret, name: "iPhone · Safari" });
  return redeemed;
}

test("只有隧道的公网域名能兑换", async () => {
  const response = await route.POST(post({ id: "x", claimSecret: "y" }, { host: "localhost" }));
  assert.equal(response.status, 403);
});

test("未知 id / 错误 claimSecret 一律 401", async () => {
  assert.equal((await route.POST(post({ id: "missing", claimSecret: "secret" }))).status, 401);
  const redeemed = pendingPairing();
  assert.equal((await route.POST(post({ id: redeemed.id, claimSecret: "wrong" }))).status, 401);
  assert.equal((await route.POST(post("x"))).status, 400);
});

test("未批准回 pending；批准后签发 Cookie，且令牌只出现在 Set-Cookie 里", async () => {
  const redeemed = pendingPairing();
  const waiting = await route.POST(post({ id: redeemed.id, claimSecret: redeemed.claimSecret }));
  assert.equal(waiting.status, 200);
  assert.deepEqual(await waiting.json(), { status: "pending" });
  assert.equal(waiting.headers.get("set-cookie"), null);

  pairing.answerPairing(redeemed.id, "approve");
  const approved = await route.POST(post({ id: redeemed.id, claimSecret: redeemed.claimSecret }));
  assert.equal(approved.status, 200);

  const cookie = approved.headers.get("set-cookie");
  assert.ok(cookie, "an approved claim must set the device cookie");
  assert.match(cookie, /^__Host-pi-remote=/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=\d+/);
  const token = /^__Host-pi-remote=([^;]+)/.exec(cookie)[1];
  assert.ok(token.length >= 32);

  const body = await approved.json();
  assert.equal(body.status, "approved");
  assert.equal(body.deviceId, redeemed.id);
  assert.equal(typeof body.expiresAt, "number");
  assert.ok(!JSON.stringify(body).includes(token), "the plaintext token must not ride along in JSON");
  assert.ok(!readFileSync(storePath, "utf8").includes(token), "the plaintext token must not reach the store");
  assert.equal(devices.verifyDeviceToken(token)?.id, redeemed.id);

  // 一次性：同一条 pending 被兑换过后再试就 401。
  const replay = await route.POST(post({ id: redeemed.id, claimSecret: redeemed.claimSecret }));
  assert.equal(replay.status, 401);
});

test("被拒绝回 rejected；之后同一条请求作废", async () => {
  const redeemed = pendingPairing();
  pairing.answerPairing(redeemed.id, "reject");
  const rejected = await route.POST(post({ id: redeemed.id, claimSecret: redeemed.claimSecret }));
  assert.equal(rejected.status, 200);
  assert.deepEqual(await rejected.json(), { status: "rejected" });
  assert.equal(rejected.headers.get("set-cookie"), null);

  const replay = await route.POST(post({ id: redeemed.id, claimSecret: redeemed.claimSecret }));
  assert.equal(replay.status, 401);
});
