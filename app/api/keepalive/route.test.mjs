import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/keepalive` —— 挂机保活开关与守护脚本动作。
 *
 * 只跑不需要真实服务/真实 OS 调度的部分：GET 形状、PUT 校验与本机限定、POST 的
 * 参数校验与「脚本缺失/脚本非零退出」两条降级路径（用临时假脚本注入）。
 */

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalScript = process.env.PI_KEEPALIVE_SUPERVISOR_SCRIPT;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-web-keepalive-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
delete process.env.PI_KEEPALIVE_SUPERVISOR_SCRIPT;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT, POST } = await jiti.import("./route.ts");

const settingsPath = join(testAgentDir, "keepalive", "settings.json");
const stopMarkerPath = join(testAgentDir, "keepalive", "manually-stopped");

after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalScript === undefined) delete process.env.PI_KEEPALIVE_SUPERVISOR_SCRIPT;
  else process.env.PI_KEEPALIVE_SUPERVISOR_SCRIPT = originalScript;
  rmSync(testAgentDir, { recursive: true, force: true });
});

function jsonRequest(method, body, { contentType = "application/json", headers = {} } = {}) {
  return new Request("http://localhost/api/keepalive", {
    method,
    headers: { "Content-Type": contentType, Host: "localhost", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("GET 返回状态形状：默认关闭、数据目录在测试 agentDir 下、no-store", async () => {
  const response = await GET(new Request("http://localhost/api/keepalive", { headers: { Host: "localhost" } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json();
  assert.equal(body.version, 1);
  assert.equal(body.enabled, false);
  assert.equal(body.server.pid, process.pid);
  assert.equal(body.dataDir, join(testAgentDir, "keepalive"));
  assert.equal(body.autofix, null);
  assert.equal(body.supervisor.stopped, false);
});

test("PUT：content-type / 形状校验", async () => {
  const wrongType = await PUT(jsonRequest("PUT", { enabled: true }, { contentType: "text/plain" }));
  assert.equal(wrongType.status, 415);

  const badJson = await PUT(jsonRequest("PUT", "{not json"));
  assert.equal(badJson.status, 400);

  const badShape = await PUT(jsonRequest("PUT", { enabled: "yes" }));
  assert.equal(badShape.status, 400);
  assert.match((await badShape.json()).error, /boolean/);
});

test("PUT：中继重放的手机请求 403（本机限定）", async () => {
  const { RELAY_MARK_HEADER } = await jiti.import("@/lib/relay/mark.ts");
  const response = await PUT(jsonRequest("PUT", { enabled: true }, { headers: { [RELAY_MARK_HEADER]: "phone" } }));
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /on this computer/);
});

test("PUT：打开开关写盘并清掉停止标记；关闭开关写 false", async () => {
  const dir = join(testAgentDir, "keepalive");
  mkdirSync(dir, { recursive: true });
  writeFileSync(stopMarkerPath, JSON.stringify({ at: new Date().toISOString(), reason: "stop" }));

  const response = await PUT(jsonRequest("PUT", { enabled: true }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.enabled, true);
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).enabled, true);
  assert.equal(existsSync(stopMarkerPath), false, "显式开启 = 用户要求继续跑，清停止标记");

  const off = await PUT(jsonRequest("PUT", { enabled: false }));
  assert.equal(off.status, 200);
  assert.equal((await off.json()).enabled, false);
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).enabled, false);
});

test("POST：动作校验；脚本缺失 501", async () => {
  const wrong = await POST(jsonRequest("POST", { action: "explode" }));
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json()).error, /check, start, install, uninstall/);

  process.env.PI_KEEPALIVE_SUPERVISOR_SCRIPT = join(testAgentDir, "missing-supervisor.mjs");
  const missing = await POST(jsonRequest("POST", { action: "check" }));
  assert.equal(missing.status, 501);
  assert.match((await missing.json()).error, /not available/);
});

test("POST：脚本非零退出原样透出退出码与输出（不当作 HTTP 失败）", async () => {
  const scriptPath = join(testAgentDir, "fake-supervisor.mjs");
  writeFileSync(
    scriptPath,
    "console.log(JSON.stringify({ verdict: 'degraded', note: process.argv.slice(2).join(' ') }));\n"
    + "process.exit(2);\n",
  );
  process.env.PI_KEEPALIVE_SUPERVISOR_SCRIPT = scriptPath;

  const response = await POST(jsonRequest("POST", { action: "check" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.action, "check");
  assert.equal(body.exitCode, 2);
  assert.match(body.output, /degraded/);
  assert.match(body.output, /--respect-stop/);
});
