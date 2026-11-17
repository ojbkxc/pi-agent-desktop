import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/public-access/diagnose` —— 设置页「检查配置」的服务端一半。
 *
 * 只跑不需要外网的路径：本机限定（两步 403）、五项检查的形状，以及直连/快速隧道
 * 下的 skipped 结论。DNS/公网健康检查在没有域名的用例里恒为 skipped，因此这里
 * 不依赖任何出网能力。
 */

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalCloudflared = process.env.PI_WEB_CLOUDFLARED;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-web-public-access-diagnose-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");

after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalCloudflared === undefined) delete process.env.PI_WEB_CLOUDFLARED;
  else process.env.PI_WEB_CLOUDFLARED = originalCloudflared;
});

const settingsPath = join(testAgentDir, "pi-web", "settings.json");

/** 写一份最小公开访问配置；networkProxy 不写 = 默认直连。 */
function writePublicAccess(overrides) {
  mkdirSync(join(testAgentDir, "pi-web"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({
    version: 1,
    publicAccess: {
      enabled: false,
      mode: "quick",
      localPort: 30141,
      token: "",
      customUrl: "",
      autoStart: false,
      consentVersion: 0,
      origin: "",
      ...overrides,
    },
  }));
}

function postRequest({ host = "localhost", headers = {} } = {}) {
  return new Request("http://localhost/api/public-access/diagnose", {
    method: "POST",
    headers: { Host: host, ...headers },
  });
}

const CHECKS = ["binary", "proxy", "token", "dns", "origin"];

test("非本机 Host 被拒绝（403）", async () => {
  const response = await POST(postRequest({ host: "192.0.2.10:30141" }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Diagnostics can only be run on this computer.");
});

test("被转发的请求（x-forwarded-for 非回环）被拒绝（403）", async () => {
  const response = await POST(postRequest({ headers: { "x-forwarded-for": "203.0.113.9" } }));
  assert.equal(response.status, 403);
});

test("本机请求返回五项检查；直连 + 快速隧道下代理/Token/DNS/公网地址为 skipped", async () => {
  // 把连接器指到本进程自身：二进制检查在任何平台都稳定为 ok（source=env）。
  process.env.PI_WEB_CLOUDFLARED = process.execPath;
  writePublicAccess({});

  const response = await POST(postRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body.checks.map((check) => check.id), CHECKS);
  const byId = Object.fromEntries(body.checks.map((check) => [check.id, check]));

  assert.equal(byId.binary.status, "ok");
  assert.equal(byId.binary.info, "env");
  // 直连档没有代理可测。
  assert.equal(byId.proxy.status, "skipped");
  // 快速隧道没有 Token。
  assert.equal(byId.token.status, "skipped");
  // 没有公网域名，DNS 与公网健康检查都无从谈起。
  assert.equal(byId.dns.status, "skipped");
  assert.equal(byId.origin.status, "skipped");
});

test("命名隧道的合法 Token 解出隧道 id，形状检查为 ok", async () => {
  process.env.PI_WEB_CLOUDFLARED = process.execPath;
  const tunnelId = "0f2f2e2a-1234-4abc-8def-0123456789ab";
  const token = Buffer.from(JSON.stringify({
    a: "account-id",
    t: tunnelId,
    s: Buffer.from("tunnel-secret").toString("base64"),
  })).toString("base64");
  writePublicAccess({ mode: "named", token });

  const body = await (await POST(postRequest())).json();
  const tokenCheck = body.checks.find((check) => check.id === "token");
  assert.equal(tokenCheck.status, "ok");
  assert.equal(tokenCheck.info, tunnelId);
});

test("存下来的 Token 形状不合法时检查为 failed", async () => {
  process.env.PI_WEB_CLOUDFLARED = process.execPath;
  // 读配置时非 cloudflared 凭据会被丢弃，命名隧道因此没有可用 Token。
  writePublicAccess({ mode: "named", token: "definitely-not-a-tunnel-token" });

  const body = await (await POST(postRequest())).json();
  const tokenCheck = body.checks.find((check) => check.id === "token");
  assert.equal(tokenCheck.status, "failed");
  assert.equal(typeof tokenCheck.error, "string");
});
