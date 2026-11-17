import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";

/**
 * lib/public-access/devices.ts：设备令牌表。
 *
 * 每个用例在临时 PI_CODING_AGENT_DIR 上跑，绝不碰真实 ~/.pi/agent。
 * 反向断言：设备令牌明文绝不落盘，文件里只有 sha256。
 */
const dir = mkdtempSync(join(tmpdir(), "pi-public-access-devices-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;

const devices = await import("./devices.ts");
const storePath = devices.publicAccessDevicesPath();
mkdirSync(join(dir, "pi-web"), { recursive: true });

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(storePath, { force: true });
});

const created = (name = "iPhone · Safari", now = 1_000) => devices.createDevice({ name, now });

test("设备令牌只存 sha256：明文不落盘，视图不含哈希", () => {
  const { device, token } = created();
  const file = readFileSync(storePath, "utf8");
  assert.ok(!file.includes(token), "plaintext device token must never reach the file");
  assert.ok(file.includes(devices.hashDeviceToken(token)), "the store keeps the sha256 hash");
  assert.equal(devices.hashDeviceToken(token).length, 64);
  assert.deepEqual(Object.keys(device).sort(), ["createdAt", "expiresAt", "id", "lastUsedAt", "name"]);
  assert.equal(device.name, "iPhone · Safari");
});

test("verifyDeviceToken：命中、坏令牌、过期（expiresAt 不含）", () => {
  const { device, token } = created();
  const now = 2_000;
  assert.equal(devices.verifyDeviceToken(token, now)?.id, device.id);
  assert.equal(devices.verifyDeviceToken(`${token}x`, now), null);
  assert.equal(devices.verifyDeviceToken("", now), null);
  assert.equal(devices.verifyDeviceToken(null, now), null);
  assert.equal(devices.verifyDeviceToken("a".repeat(513), now), null);
  assert.equal(devices.verifyDeviceToken(token, device.expiresAt), null, "expiry is exclusive");
});

test("撤销即刻生效；撤销不存在的设备返回 false", () => {
  const { device, token } = created();
  assert.equal(devices.verifyDeviceToken(token, 2_000)?.id, device.id);
  assert.equal(devices.revokeDevice(device.id), true);
  assert.equal(devices.verifyDeviceToken(token, 2_000), null);
  assert.equal(devices.revokeDevice(device.id), false);
  assert.deepEqual(devices.listDevices(2_000), []);
});

test("listDevices：排除过期、按签发时间排序、拒绝暴露 tokenHash", () => {
  const a = created("A", 1_000).device;
  const b = created("B", 2_000).device;
  const expired = created("Old", 3_000).device;
  // 直接改文件把第三台改成过期，模拟时间流逝后的表。
  const store = JSON.parse(readFileSync(storePath, "utf8"));
  for (const row of store.devices) {
    if (row.id === expired.id) row.expiresAt = 5_000;
  }
  writeFileSync(storePath, JSON.stringify(store));

  const list = devices.listDevices(10_000);
  assert.deepEqual(list.map((entry) => entry.name), ["A", "B", "Old"].filter((name) => name !== "Old"));
  assert.deepEqual(list.map((entry) => entry.id), [a.id, b.id]);
  for (const entry of list) assert.ok(!("tokenHash" in entry));
});

test("lastUsedAt 只在明显变旧时落盘（每设备约一分钟一次）", () => {
  const { token } = created("Phone", 1_000);
  devices.verifyDeviceToken(token, 30_000); // 30s：不写盘
  assert.equal(JSON.parse(readFileSync(storePath, "utf8")).devices[0].lastUsedAt, undefined);
  devices.verifyDeviceToken(token, 120_000); // 超过一分钟：写盘
  const row = JSON.parse(readFileSync(storePath, "utf8")).devices[0];
  assert.equal(row.lastUsedAt, 120_000);
  assert.equal(devices.verifyDeviceToken(token, 130_000)?.lastUsedAt, 120_000);
});

test("坏文件 / 未来版本一律视为没有设备（fail-closed）", () => {
  writeFileSync(storePath, "{damaged");
  assert.equal(devices.verifyDeviceToken("anything", 1_000), null);
  assert.deepEqual(devices.listDevices(1_000), []);
  assert.equal(devices.countDevices(1_000), 0);

  writeFileSync(storePath, JSON.stringify({ version: 99, devices: [{ id: "x" }] }));
  assert.deepEqual(devices.listDevices(1_000), []);

  // 写回一个合法空表，后续 beforeEach 删除它也不受影响。
  assert.equal(devices.revokeDevice("missing"), false);
});

test("Cookie / Bearer 是请求携带设备令牌的两条通道", () => {
  const { token } = created("Phone", 1_000);
  const withCookie = new Request("http://pi.example.com/", {
    headers: { cookie: `other=1; ${devices.PUBLIC_ACCESS_DEVICE_COOKIE}=${token}` },
  });
  assert.equal(devices.deviceTokenFromRequest(withCookie), token);
  assert.equal(devices.isDeviceAuthenticatedRequest(withCookie, 2_000), true);

  const withBearer = new Request("http://pi.example.com/", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(devices.deviceTokenFromRequest(withBearer), token);

  const none = new Request("http://pi.example.com/", { headers: { cookie: "a=b" } });
  assert.equal(devices.deviceTokenFromRequest(none), null);
  assert.equal(devices.isDeviceAuthenticatedRequest(none, 2_000), false);
});

test("设备名清洗；Cookie 头带 __Host- 的四件套属性", () => {
  assert.equal(devices.sanitizeDeviceName("  iPhone\u0000 · Safari  "), "iPhone · Safari");
  assert.equal(devices.sanitizeDeviceName(""), "Mobile browser");
  assert.equal(devices.sanitizeDeviceName(42), "Mobile browser");
  assert.equal(devices.sanitizeDeviceName("x".repeat(200)).length, 80);
  const header = devices.deviceCookieHeader("tok");
  assert.match(header, /^__Host-pi-remote=tok; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  assert.ok(header.endsWith(`Max-Age=${devices.PUBLIC_ACCESS_DEVICE_TTL_MS / 1000}`));
});

test("配对路径白名单只放两条手机接口和配对页", () => {
  assert.equal(devices.isPublicAccessPairingPath("/pair"), true);
  assert.equal(devices.isPublicAccessPairingPath("/api/public-access/pair"), true);
  assert.equal(devices.isPublicAccessPairingPath("/api/public-access/pair/claim"), true);
  assert.equal(devices.isPublicAccessPairingPath("/api/public-access/pair/qr"), false);
  assert.equal(devices.isPublicAccessPairingPath("/api/agent/x"), false);
  assert.equal(devices.isPublicAccessPairingPath("/"), false);
});
