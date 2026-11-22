import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * 「JSON 体不是对象」的回归测试。
 *
 * 缺陷：`null`、数字、字符串都是合法 JSON，`await req.json()` 不会抛；随后
 * `body.subscription` / `body.op` / `body.serverPort` 或解构 `const { token } = body`
 * 在 try 之外抛 TypeError。表现是 **500 + 非 JSON 体**（前端 `res.json()` 直接炸），
 * 而真正的问题是请求体形状不对，应当是 400 + `{ error }`。
 *
 * 路由跑在 Next 里，Host 头一定存在；合成 Request 默认没有，要显式补上，否则
 * `isApiRequestAllowed` 按「不可信来源」拒绝，测到的就不是被测分支。
 */

const agentDir = mkdtempSync(join(tmpdir(), "pi-body-guard-agent-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });

const LOOPBACK_HEADERS = { Host: "localhost" };

const jsonRequest = (url, method, raw) => new Request(url, {
  method,
  headers: { ...LOOPBACK_HEADERS, "Content-Type": "application/json" },
  body: raw,
});

/** `null` 是最直接的「合法 JSON 但不是对象」，也是先前 500 的触发输入。 */
const nullBodyRequest = (url, method) => jsonRequest(url, method, "null");

/**
 * 本机节点包不全（`app/api/push/subscribe` 静态依赖 `web-push`）：缺包是环境问题，
 * 不该让整份用例红掉，用例跳过并说明原因。包在的机器上照常断言。
 */
async function loadRouteOrSkip(t, path) {
  try {
    return await jiti.import(path);
  } catch (error) {
    if (/Cannot find module/.test(String(error?.message))) {
      t.skip(`environment: ${error.message.split("\n")[0]}`);
      return null;
    }
    throw error;
  }
}

async function assertBadBody(response, label) {
  assert.equal(response.status, 400, `${label}: expected 400, got ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  assert.match(contentType, /application\/json/, `${label}: body must be JSON, got "${contentType}"`);
  const payload = await response.json();
  assert.equal(typeof payload.error, "string", `${label}: error must be a string`);
  assert.ok(payload.error.length > 0, `${label}: error must not be empty`);
}

test("POST /api/auth/login/[provider]：null 体 → 400 而不是 500", async () => {
  const route = await jiti.import("./auth/login/[provider]/route.ts");
  const response = await route.POST(
    nullBodyRequest("http://localhost/api/auth/login/anthropic", "POST"),
    { params: Promise.resolve({ provider: "anthropic" }) },
  );
  await assertBadBody(response, "auth/login");
});

test("POST /api/push/subscribe：null 体 → 400 而不是 500", async (t) => {
  const route = await loadRouteOrSkip(t, "./push/subscribe/route.ts");
  if (!route) return;
  const response = await route.POST(nullBodyRequest("http://localhost/api/push/subscribe", "POST"));
  await assertBadBody(response, "push/subscribe");
});

test("PUT /api/models/enabled：null 体 → 400 而不是 500", async () => {
  const route = await jiti.import("./models/enabled/route.ts");
  const response = await route.PUT(nullBodyRequest("http://localhost/api/models/enabled", "PUT"));
  await assertBadBody(response, "models/enabled");
});

test("PUT /api/server-settings：null 体 → 400（此前被 catch 成 500）", async () => {
  const route = await jiti.import("./server-settings/route.ts");
  const response = await route.PUT(nullBodyRequest("http://localhost/api/server-settings", "PUT"));
  await assertBadBody(response, "server-settings");
});

test("数组体同样被拒：数组是对象，但不是这个接口要的对象", async () => {
  const route = await jiti.import("./models/enabled/route.ts");
  const response = await route.PUT(jsonRequest("http://localhost/api/models/enabled", "PUT", "[1,2,3]"));
  await assertBadBody(response, "models/enabled(array)");
});

test("POST /api/skills/search：null 体 → 400（此前被 npx 兜底分支吞成 500）", async (t) => {
  const route = await loadRouteOrSkip(t, "./skills/search/route.ts");
  if (!route) return;
  const response = await route.POST(nullBodyRequest("http://localhost/api/skills/search", "POST"));
  await assertBadBody(response, "skills/search");
});

// Malformed JSON (JSON.parse throws) used to fall through to the catch-all and
// become a 500 with a non-JSON/raw-error body. These routes must answer 400.

test("POST /api/scheduled-tasks：非法 JSON → 400 而不是 500", async () => {
  const route = await jiti.import("./scheduled-tasks/route.ts");
  const response = await route.POST(jsonRequest("http://localhost/api/scheduled-tasks", "POST", "{not json"));
  await assertBadBody(response, "scheduled-tasks");
});

test("PATCH /api/scheduled-tasks/[id]：非法 JSON → 400 而不是 500", async () => {
  const route = await jiti.import("./scheduled-tasks/[id]/route.ts");
  const response = await route.PATCH(
    jsonRequest("http://localhost/api/scheduled-tasks/x", "PATCH", "{not json"),
    { params: Promise.resolve({ id: "x" }) },
  );
  await assertBadBody(response, "scheduled-tasks/[id]");
});

test("POST /api/memory：非法 JSON → 400 而不是 500", async () => {
  const route = await jiti.import("./memory/route.ts");
  const response = await route.POST(jsonRequest("http://localhost/api/memory", "POST", "{not json"));
  await assertBadBody(response, "memory");
});

test("PATCH /api/memory/[id]：非法 JSON → 400 而不是 500", async () => {
  const route = await jiti.import("./memory/[id]/route.ts");
  const response = await route.PATCH(
    jsonRequest("http://localhost/api/memory/m1", "PATCH", "{not json"),
    { params: Promise.resolve({ id: "m1" }) },
  );
  await assertBadBody(response, "memory/[id]");
});

test("POST /api/autofix：非法 JSON → 400 而不是 500", async (t) => {
  const route = await loadRouteOrSkip(t, "./autofix/route.ts");
  if (!route) return;
  const response = await route.POST(jsonRequest("http://localhost/api/autofix", "POST", "{not json"));
  await assertBadBody(response, "autofix");
});