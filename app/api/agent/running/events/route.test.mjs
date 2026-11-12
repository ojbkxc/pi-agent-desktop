import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/agent/running/events` 的心跳必须是**真实 data 帧**，而不是裸 SSE 注释。
 *
 * 侧栏把这条流当作运行态的唯一权威来源（首帧之后不再采信 /api/sessions 的
 * runningSessionIds）。连接半开时注释仍然流、但状态变化丢了，客户端就会把最后一帧
 * 里的运行集合——连同那颗转圈——永远留在屏幕上（2026-11-12 用户实报「转圈卡住」）。
 * 心跳重复当前快照，等于每 30 秒强制对一次账。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const route = await jiti.import("./route.ts");
const rpc = await jiti.import("@/lib/rpc-manager.ts");

async function readFirstFrames(count, timeoutMs = 2000) {
  const response = await route.GET(new Request("http://127.0.0.1/api/agent/running/events"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ value: undefined, done: false }), 200)),
    ]);
    if (value) text += decoder.decode(value, { stream: true });
    if (done) break;
    if (text.split("data: ").length - 1 >= count) break;
  }
  await reader.cancel().catch(() => {});
  return text;
}

test("initial frame carries the running snapshot as a data event", async () => {
  const text = await readFirstFrames(1);
  const frames = text.split("\n\n").filter((frame) => frame.trim());
  assert.ok(frames.length >= 1, `no frames: ${JSON.stringify(text)}`);
  const first = frames[0];
  assert.match(first, /^data: /, `first frame must be a data event, got ${JSON.stringify(first)}`);
  const payload = JSON.parse(first.slice("data: ".length));
  assert.equal(payload.type, "running");
  assert.ok(Array.isArray(payload.runningSessionIds));
  assert.equal(typeof payload.sessionListVersion, "number");
});

test("a state change is broadcast with its own data frame", async () => {
  // 订阅后触发一次广播：帧必须带最新的运行集合（不是注释）。
  const response = await route.GET(new Request("http://127.0.0.1/api/agent/running/events"));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const pump = (async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ value: undefined, done: false }), 200)),
      ]);
      if (value) text += decoder.decode(value, { stream: true });
      if (done) break;
      if (text.split("data: ").length - 1 >= 2) break;
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 150));
  rpc.notifyRunningChange();
  await pump;
  await reader.cancel().catch(() => {});
  const payloads = text.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)));
  assert.ok(payloads.length >= 1, `no data frames: ${JSON.stringify(text)}`);
  for (const payload of payloads) {
    assert.equal(payload.type, "running");
    assert.ok(Array.isArray(payload.runningSessionIds));
  }
});