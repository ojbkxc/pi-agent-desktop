/**
 * `GET /api/purge/gate-log`：只读的闸门归属视图。
 *
 * 载荷与守卫分开断言。守卫那半不伪造 `host` 头来"通过"：Node 的 `Request` 不带
 * `host`，所以一个合成的请求本来就该被拒——这正是要钉住的行为。载荷那半直接打
 * `gateLogPayload()`，验它给出的计数与事件。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});
const { GET } = await jiti.import("./route.ts");
const { gateLogPayload } = await jiti.import("@/lib/gate-attribution");
// 与 route.ts 用同一个 specifier，才能落到同一个模块实例：否则两边各拿一份环形
// 记录，测试里的 recordGate 写不到路由读的那一份。
const { clearGateEvents, recordGate } = await jiti.import("@/lib/gate-attribution");

test("payload 给出归属计数与最近事件", () => {
  clearGateEvents();
  recordGate({ layer: "tool-approval", decision: "denied", reason: "rejected" });
  recordGate({ layer: "mcp-trust", decision: "denied", reason: "not-trusted" });

  const body = gateLogPayload();
  assert.equal(body.attribution.byDecision.denied, 2);
  assert.equal(body.attribution.byDecision.allowed, 0);
  assert.equal(body.attribution.byLayer["tool-approval"], 1);
  assert.equal(body.attribution.byLayer["mcp-trust"], 1);
  assert.equal(body.attribution.byLayer["permission-gate"], 0);
  assert.equal(body.events.length, 2);
  assert.equal(body.events[0].reason, "rejected");
  clearGateEvents();
});

test("空记录时每个层都是 0，事件为空数组", () => {
  clearGateEvents();
  const body = gateLogPayload();
  assert.deepEqual(body.events, []);
  for (const count of Object.values(body.attribution.byLayer)) assert.equal(count, 0);
  assert.deepEqual(body.attribution.byDecision, { allowed: 0, denied: 0 });
});

test("snapshot 是副本：拿到之后再记录不影响已取到的结果", () => {
  clearGateEvents();
  const first = gateLogPayload();
  recordGate({ layer: "project-trust", decision: "denied", reason: "project-untrusted" });
  assert.equal(first.events.length, 0);
  assert.equal(gateLogPayload().events.length, 1);
  clearGateEvents();
});

test("没有 host 头的合成请求被拒（守卫在位）", async () => {
  const response = await GET(new Request("http://localhost/api/purge/gate-log"));
  assert.equal(response.status, 403);
});
