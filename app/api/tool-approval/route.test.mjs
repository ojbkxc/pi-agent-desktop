import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/tool-approval` —— 命令审批模式的读写接口。
 *
 * 只跑不需要会话的部分：GET 形状与默认值、PUT 的校验与本机限定、落盘的键名。
 * 审批语义本身在 lib/tool-approval/*.test.mjs 里锁住。
 */

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-web-tool-approval-route-"));
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
  rmSync(testAgentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const settingsPath = join(testAgentDir, "pi-web", "settings.json");

function putRequest(body, { contentType = "application/json", headers = {} } = {}) {
  return new Request("http://localhost/api/tool-approval", {
    method: "PUT",
    headers: { "Content-Type": contentType, Host: "localhost", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("GET：默认 off，回档位清单与本机标记，no-store", async () => {
  const response = await GET(new Request("http://localhost/api/tool-approval", { headers: { Host: "localhost" } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json();
  assert.equal(body.mode, "off");
  assert.deepEqual(body.modes, ["off", "dangerous", "all"]);
  assert.equal(body.local, true);
});

test("PUT：落盘 toolApprovalMode，回显生效值；GET 读到同一档", async () => {
  const response = await PUT(putRequest({ mode: "dangerous" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "dangerous");
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).toolApprovalMode, "dangerous");

  const read = await GET(new Request("http://localhost/api/tool-approval", { headers: { Host: "localhost" } }));
  assert.equal((await read.json()).mode, "dangerous");

  const off = await PUT(putRequest({ mode: "off" }));
  assert.equal((await off.json()).mode, "off");
});

test("PUT：只改这一个键，Pi Web 其它设置原样保留", async () => {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ version: 1, artifactsPrompt: false, leanMode: true }));
  await PUT(putRequest({ mode: "all" }));
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    version: 1,
    artifactsPrompt: false,
    leanMode: true,
    toolApprovalMode: "all",
  });
});

test("PUT 拒绝：非法档位 / content-type 不对 / 坏 JSON", async () => {
  const bad = await PUT(putRequest({ mode: "sometimes" }));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /off, dangerous, all/);

  const missing = await PUT(putRequest({}));
  assert.equal(missing.status, 400);

  const wrongType = await PUT(putRequest({ mode: "off" }, { contentType: "text/plain" }));
  assert.equal(wrongType.status, 415);

  const badJson = await PUT(putRequest("{not json"));
  assert.equal(badJson.status, 400);
  assert.match((await badJson.json()).error, /Invalid JSON/);
});

test("PUT 只允许本机：中继重放的手机请求 403", async () => {
  const { RELAY_MARK_HEADER } = await jiti.import("@/lib/relay/mark.ts");
  const response = await PUT(putRequest({ mode: "off" }, { headers: { [RELAY_MARK_HEADER]: "phone" } }));
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /on this computer/);
});