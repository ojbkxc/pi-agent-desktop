import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/network-proxy` —— 会话流量代理的读写接口。
 *
 * 只跑不需要网络的部分：GET 的形状、PUT 的校验与本机限定、以及落盘的键。
 * 「代理真的生效」在 lib/network-proxy.test.mjs 里对着本地假代理验过。
 */

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-web-network-proxy-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");

after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

const settingsPath = join(testAgentDir, "pi-web", "settings.json");

function putRequest(body, { contentType = "application/json", host = "localhost", headers = {} } = {}) {
  return new Request("http://localhost/api/network-proxy", {
    method: "PUT",
    headers: { "Content-Type": contentType, Host: host, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("GET 回档位、生效代理与本机标记；缺省是直连", async () => {
  const response = await GET(new Request("http://localhost/api/network-proxy", { headers: { Host: "localhost" } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json();
  assert.equal(body.mode, "direct");
  assert.equal(body.url, "");
  assert.equal(body.local, true);
  // 直连档不探测系统代理，也不装代理。
  assert.equal(body.activeProxy, null);
  assert.equal(body.systemProxy, null);
});

test("PUT manual 落盘并回显生效值", async () => {
  const response = await PUT(putRequest({ mode: "manual", url: "127.0.0.1:7890" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "manual");
  assert.equal(body.url, "http://127.0.0.1:7890");
  assert.equal(body.activeProxy, "http://127.0.0.1:7890");
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).networkProxy, {
    mode: "manual",
    url: "http://127.0.0.1:7890",
  });
  // 随后的 GET 读到的也是它。
  const read = await GET(new Request("http://localhost/api/network-proxy", { headers: { Host: "localhost" } }));
  assert.equal((await read.json()).mode, "manual");
});

test("PUT direct 清掉代理，NO_PROXY 变成通配", async () => {
  const response = await PUT(putRequest({ mode: "direct" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "direct");
  assert.equal(body.activeProxy, null);
  assert.equal(process.env.NO_PROXY, "*");
});

test("PUT 拒绝：非法档位 / manual 没有可用 URL / content-type 不对", async () => {
  const bad = await PUT(putRequest({ mode: "socks" }));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /mode must be one of/);

  const noUrl = await PUT(putRequest({ mode: "manual", url: "" }));
  assert.equal(noUrl.status, 400);
  assert.match((await noUrl.json()).error, /http:\/\/ or https:\/\//);

  const socksUrl = await PUT(putRequest({ mode: "manual", url: "socks5://127.0.0.1:1080" }));
  assert.equal(socksUrl.status, 400);

  const wrongType = await PUT(putRequest({ mode: "direct" }, { contentType: "text/plain" }));
  assert.equal(wrongType.status, 415);
});

test("PUT 只允许本机：来自中继的请求 403", async () => {
  // 中继会把手机的请求从 127.0.0.1 重放，靠标记头区分（lib/remote-access.ts）。
  const { RELAY_MARK_HEADER } = await jiti.import("@/lib/relay/mark.ts");
  const response = await PUT(putRequest({ mode: "direct" }, { headers: { [RELAY_MARK_HEADER]: "phone" } }));
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /only be changed on this computer/);
});
