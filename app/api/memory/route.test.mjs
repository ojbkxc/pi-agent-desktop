import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/memory` 与 `/api/memory/[id]` 的接线：状态码、响应形状、服务端校验、落盘路径。
 *
 * agent dir 用 `PI_CODING_AGENT_DIR` 指向临时目录（`getAgentDir()` 的唯一 env 入口，
 * 见 SDK config.js），store 的默认路径因此随路由一起被验证，不依赖真实 `~/.pi`。
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const listRoute = await jiti.import("./route.ts");
const itemRoute = await jiti.import("./[id]/route.ts");

function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-api-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    });
}

// 路由跑在 Next 里，Host 头一定存在；合成 Request 默认没有，要显式补上（否则
// `isApiRequestAllowed` 按「不可信来源」拒绝，测试就测不到路由本身）。
const LOOPBACK_HEADERS = { Host: "localhost" };

const jsonRequest = (body, method = "POST") => new Request("http://localhost/api/memory", {
  method,
  headers: { ...LOOPBACK_HEADERS, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const writeRequest = (url, method, body) => new Request(url, {
  method,
  headers: { ...LOOPBACK_HEADERS, "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const params = (id) => ({ params: Promise.resolve({ id }) });

test("GET 空列表 → { entries: [] }，落盘文件此时不存在", () => withAgentDir(async (dir) => {
  const response = await listRoute.GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { entries: [] });
  assert.equal(existsSync(join(dir, "pi-web", "memory.json")), false);
}));

test("POST 新增 → 201 { entry }，并写进 <agent dir>/pi-web/memory.json", () => withAgentDir(async (dir) => {
  const response = await listRoute.POST(jsonRequest({ text: "  user prefers pnpm  ", tags: ["pref"] }));
  assert.equal(response.status, 201);
  const { entry } = await response.json();
  assert.equal(entry.text, "user prefers pnpm");
  assert.deepEqual(entry.tags, ["pref"]);
  assert.match(entry.id, /^[0-9a-f-]{36}$/);
  const raw = JSON.parse(readFileSync(join(dir, "pi-web", "memory.json"), "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.entries[0].id, entry.id);

  const list = await (await listRoute.GET()).json();
  assert.equal(list.entries.length, 1);
  assert.equal(list.entries[0].text, "user prefers pnpm");
}));

test("POST 校验：空文本 / 非字符串 / 非对象 → 400 且 code=validation；415 无 JSON 头", () => withAgentDir(async () => {
  const empty = await listRoute.POST(jsonRequest({ text: "   " }));
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { error: "text must not be empty", code: "validation" });

  const kind = await listRoute.POST(jsonRequest({ text: 5 }));
  assert.equal(kind.status, 400);
  assert.equal((await kind.json()).code, "validation");

  const array = await listRoute.POST(jsonRequest([1, 2]));
  assert.equal(array.status, 400);

  const noJson = await listRoute.POST(new Request("http://localhost/api/memory", {
    method: "POST",
    headers: LOOPBACK_HEADERS,
    body: "{}",
  }));
  assert.equal(noJson.status, 415);
}));

test("POST 超 4KB → 400，且不落盘", () => withAgentDir(async (dir) => {
  const response = await listRoute.POST(jsonRequest({ text: "a".repeat(4097) }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /at most 4096 bytes/);
  assert.throws(() => readFileSync(join(dir, "pi-web", "memory.json")), /ENOENT/);
}));

test("PATCH 行内编辑 → { entry }；未知 id → 404；空 patch → 400", () => withAgentDir(async () => {
  const { entry } = await (await listRoute.POST(jsonRequest({ text: "before" }))).json();
  const patched = await itemRoute.PATCH(
    writeRequest(`http://localhost/api/memory/${entry.id}`, "PATCH", { text: "after", tags: [] }),
    params(entry.id),
  );
  assert.equal(patched.status, 200);
  const body = await patched.json();
  assert.equal(body.entry.text, "after");
  assert.equal(body.entry.tags, undefined, "空标签 = 清空");

  const missing = await itemRoute.PATCH(
    writeRequest("http://localhost/api/memory/nope", "PATCH", { text: "x" }),
    params("nope"),
  );
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "Memory not found" });

  const emptyPatch = await itemRoute.PATCH(
    writeRequest("http://localhost/api/memory/x", "PATCH", {}),
    params(entry.id),
  );
  assert.equal(emptyPatch.status, 400);
  assert.match((await emptyPatch.json()).error, /nothing to update/);
}));

test("DELETE → { success: true }；再次删除 → 404", () => withAgentDir(async () => {
  const { entry } = await (await listRoute.POST(jsonRequest({ text: "doomed" }))).json();
  const first = await itemRoute.DELETE(
    new Request(`http://localhost/api/memory/${entry.id}`, { method: "DELETE", headers: LOOPBACK_HEADERS }),
    params(entry.id),
  );
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { success: true });
  assert.deepEqual(await (await listRoute.GET()).json(), { entries: [] });

  const second = await itemRoute.DELETE(
    new Request("http://localhost/api/memory/x", { method: "DELETE", headers: LOOPBACK_HEADERS }),
    params(entry.id),
  );
  assert.equal(second.status, 404);
}));

test("GET 按 updatedAt 倒序（设置页最新的在最上面）", () => withAgentDir(async () => {
  const first = await (await listRoute.POST(jsonRequest({ text: "first" }))).json();
  const second = await (await listRoute.POST(jsonRequest({ text: "second" }))).json();
  await itemRoute.PATCH(
    writeRequest("http://localhost/api/memory/x", "PATCH", { text: "first (edited)" }),
    params(first.entry.id),
  );
  const { entries } = await (await listRoute.GET()).json();
  assert.deepEqual(entries.map((entry) => entry.id), [first.entry.id, second.entry.id]);
}));