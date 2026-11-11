import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/skills/search` 的 `limit` 解析回归测试。
 *
 * 现象：`parseLimit` 用 `Number.isFinite` 判断「用户给了值」，但 `Number(null)` /
 * `Number("")` 都是 0（有限数），于是被 `Math.max(MIN_LIMIT, 0)` 夹成每页 1 条，
 * 「没传 / 空 / 非法 limit」本该回落默认 50 却变成 1。
 *
 * 该路由只在 `searchSkillsApi` 里把 limit 拼进上游 URL（不发本地网络也能断言 URL），
 * 所以 stub 掉全局 fetch 捕获请求 URL 即可。
 */

const root = await mkdtemp(join(tmpdir(), "pi-skills-search-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

let POST;
let originalFetch;
let lastLimitUrl;

before(async () => {
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
  ({ POST } = await jiti.import("./route.ts"));
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    lastLimitUrl = String(url);
    return new Response(JSON.stringify({ skills: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

const call = async (body) => {
  lastLimitUrl = undefined;
  const response = await POST(new Request("http://localhost/api/skills/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify(body),
  }));
  assert.equal(response.status, 200);
  return new URL(lastLimitUrl).searchParams.get("limit");
};

test("缺省 limit → 上游收到 50（不是 1）", async () => {
  assert.equal(await call({ query: "react" }), "50");
});

test("显式合法 limit 生效", async () => {
  assert.equal(await call({ query: "react", limit: 5 }), "5");
  assert.equal(await call({ query: "react", limit: "12" }), "12");
  assert.equal(await call({ query: "react", limit: 7.9 }), "7");
});

test("null / 空串 / 0 / 负数 / 非数字 → 回落默认 50", async () => {
  for (const limit of [null, "", 0, -3, "abc"]) {
    assert.equal(await call({ query: "react", limit }), "50", `limit=${String(limit)}`);
  }
});

test("limit 超过上限被截到 MAX_LIMIT(50)", async () => {
  assert.equal(await call({ query: "react", limit: 200 }), "50");
});
