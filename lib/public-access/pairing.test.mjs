import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";

/**
 * lib/public-access/pairing.ts：一次性 secret → pending → 批准 → claim 设备令牌。
 *
 * 每个用例在临时 PI_CODING_AGENT_DIR 上跑；配对状态在 globalThis 上，用
 * resetPairingForTests() 清干净。
 */
const dir = mkdtempSync(join(tmpdir(), "pi-public-access-pairing-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;

const pairing = await import("./pairing.ts");
const devices = await import("./devices.ts");
const storePath = devices.publicAccessDevicesPath();
mkdirSync(join(dir, "pi-web"), { recursive: true });

after(() => {
  pairing.resetPairingForTests();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  pairing.resetPairingForTests();
  rmSync(storePath, { force: true });
});

test("一次性 secret：5 分钟 TTL、只能用一次、重新生成会作废旧码", () => {
  const { secret, expiresAt } = pairing.beginPairing(1_000);
  assert.equal(expiresAt, 1_000 + pairing.PAIRING_SECRET_TTL_MS);
  assert.equal(pairing.pairingSnapshot(2_000).active, true);

  // 服务端进程内不留明文：快照里找不到 secret 本身。
  assert.ok(!JSON.stringify(pairing.pairingSnapshot(2_000)).includes(secret));

  // 错 secret 不消耗正确的 secret。
  assert.deepEqual(pairing.redeemPairingSecret({ secret: `${secret}x`, name: "Phone" }, 2_000), {
    ok: false, reason: "invalid",
  });
  // 过期即作废。
  assert.deepEqual(pairing.redeemPairingSecret({ secret, name: "Phone" }, expiresAt), {
    ok: false, reason: "invalid",
  });

  // 新码覆盖旧码。
  const first = pairing.beginPairing(10_000);
  const second = pairing.beginPairing(11_000);
  assert.equal(pairing.redeemPairingSecret({ secret: first.secret, name: "Phone" }, 12_000).ok, false);
  assert.equal(pairing.redeemPairingSecret({ secret: second.secret, name: "Phone" }, 12_000).ok, true);

  // 同一枚 secret 第二次使用必被拒绝（一次性）。
  const once = pairing.beginPairing(20_000);
  assert.equal(pairing.redeemPairingSecret({ secret: once.secret, name: "Phone" }, 21_000).ok, true);
  assert.equal(pairing.redeemPairingSecret({ secret: once.secret, name: "Phone" }, 21_500).ok, false);
});

test("approve → claim 换设备令牌；令牌不落盘，claimSecret 一次性", () => {
  const { secret } = pairing.beginPairing(1_000);
  const redeemed = pairing.redeemPairingSecret({ secret, name: "iPhone · Safari" }, 2_000);
  assert.equal(redeemed.ok, true);
  assert.equal(pairing.pairingSnapshot(2_500).pending.length, 1);

  // 未批准前 claim 只回 pending，且不消耗 claimSecret。
  assert.deepEqual(
    pairing.claimPairingDevice({ id: redeemed.id, claimSecret: redeemed.claimSecret }, 3_000),
    { status: "pending" },
  );
  assert.equal(pairing.answerPairing(redeemed.id, "approve", 3_500), "ok");
  assert.equal(pairing.answerPairing(redeemed.id, "approve", 3_600), "answered");

  const claimed = pairing.claimPairingDevice({ id: redeemed.id, claimSecret: redeemed.claimSecret }, 4_000);
  assert.equal(claimed.status, "approved");
  assert.equal(claimed.deviceId, redeemed.id);
  assert.equal(typeof claimed.token, "string");
  assert.ok(claimed.token.length >= 32);

  // 设备表只认 sha256：明文只在 claim 返回值里出现这一次。
  const file = readFileSync(storePath, "utf8");
  assert.ok(!file.includes(claimed.token));
  assert.ok(file.includes(devices.hashDeviceToken(claimed.token)));
  assert.equal(devices.verifyDeviceToken(claimed.token, 5_000)?.name, "iPhone · Safari");

  // pending 已删除：同样的 id + claimSecret 再兑换一次必失败。
  assert.deepEqual(
    pairing.claimPairingDevice({ id: redeemed.id, claimSecret: redeemed.claimSecret }, 6_000),
    { status: "invalid" },
  );
  assert.deepEqual(pairing.pairingSnapshot(6_000).pending, []);
});

test("reject：claim 回 rejected，之后同一条请求作废", () => {
  const { secret } = pairing.beginPairing(1_000);
  const redeemed = pairing.redeemPairingSecret({ secret, name: "Android · Chrome" }, 2_000);
  assert.equal(pairing.answerPairing(redeemed.id, "reject", 3_000), "ok");
  assert.deepEqual(
    pairing.claimPairingDevice({ id: redeemed.id, claimSecret: redeemed.claimSecret }, 4_000),
    { status: "rejected" },
  );
  assert.deepEqual(
    pairing.claimPairingDevice({ id: redeemed.id, claimSecret: redeemed.claimSecret }, 5_000),
    { status: "invalid" },
  );
});

test("claimSecret / id 校验与 pending 过期", () => {
  const { secret } = pairing.beginPairing(1_000);
  const redeemed = pairing.redeemPairingSecret({ secret, name: "Phone" }, 2_000);
  assert.deepEqual(
    pairing.claimPairingDevice({ id: redeemed.id, claimSecret: "not-it" }, 3_000),
    { status: "invalid" },
  );
  assert.deepEqual(
    pairing.claimPairingDevice({ id: "missing", claimSecret: redeemed.claimSecret }, 3_000),
    { status: "invalid" },
  );
  // pending 请求有自己的窗口（PAIRING_REQUEST_TTL_MS）。
  const expiresAt = 2_000 + pairing.PAIRING_REQUEST_TTL_MS;
  assert.deepEqual(
    pairing.claimPairingDevice({ id: redeemed.id, claimSecret: redeemed.claimSecret }, expiresAt),
    { status: "expired" },
  );
  assert.deepEqual(pairing.pairingSnapshot(expiresAt).pending, []);
});

test("设备上限：已配对 + 等待中的一起算", () => {
  for (let index = 0; index < devices.PUBLIC_ACCESS_MAX_DEVICES; index += 1) {
    devices.createDevice({ name: `Phone ${index}`, now: 1_000 });
  }
  const { secret } = pairing.beginPairing(2_000);
  assert.deepEqual(pairing.redeemPairingSecret({ secret, name: "Phone" }, 3_000), {
    ok: false, reason: "limit",
  });
});
