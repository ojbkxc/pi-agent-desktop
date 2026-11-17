import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";

/**
 * POST /api/public-access/pair —— 手机扫码后的第一步。
 * 状态码路径：非隧道域名 403、非 JSON 415、坏/过期 secret 401、有效 secret 200。
 */
const dir = mkdtempSync(join(tmpdir(), "pi-pair-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const route = await jiti.import("./route.ts");
const pairing = await jiti.import("../../../../lib/public-access/pairing.ts");

const ORIGIN = "https://pi.example.com";
const settingsPath = join(dir, "pi-web", "settings.json");

after(() => {
  pairing.resetPairingForTests();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  pairing.resetPairingForTests();
  mkdirSync(join(dir, "pi-web"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ publicAccess: { origin: ORIGIN } }));
});

function post(body, { host = "pi.example.com", contentType = "application/json" } = {}) {
  const headers = { host };
  if (contentType) headers["content-type"] = contentType;
  return new Request(`http://${host}/api/public-access/pair`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("只有隧道的公网域名能开始配对", async () => {
  const { secret } = pairing.beginPairing();
  const response = await route.POST(post({ secret }, { host: "localhost" }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Pairing is only available through the public tunnel address");
});

test("要求 application/json", async () => {
  const { secret } = pairing.beginPairing();
  const response = await route.POST(post({ secret }, { contentType: "text/plain" }));
  assert.equal(response.status, 415);
});

test("无效 / 过期的 secret 401；坏 JSON 400", async () => {
  assert.equal((await route.POST(post({ secret: "nope" }))).status, 401);
  // 没生成过 secret：同样是 401。
  assert.equal((await route.POST(post({ secret: "anything" }))).status, 401);
  assert.equal((await route.POST(post("{"))).status, 400);
});

test("有效 secret 换 pending 凭据；同一枚 secret 只能用一次", async () => {
  const { secret } = pairing.beginPairing();
  const first = await route.POST(post({ secret, name: "iPhone · Safari" }));
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(typeof body.id, "string");
  assert.equal(typeof body.claimSecret, "string");
  assert.equal(first.headers.get("cache-control"), "no-store");

  const again = await route.POST(post({ secret, name: "iPhone · Safari" }));
  assert.equal(again.status, 401, "the one-time secret is consumed by the first request");
});
