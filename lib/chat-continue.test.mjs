import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { forgetChatSystemPrompt } from "./chat-continue.ts";

// A-4：continue-in-project 的转录重写。旧实现 readFileSync 整文件 + 全量重写；
// 新实现两遍流式。这里用真实临时文件验证语义等价（删除、parentId 上溯、损坏即抛）。

const dir = mkdtempSync(join(tmpdir(), "pi-chat-continue-"));
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录 */ } });

function writeTranscript(lines) {
  const file = join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return file;
}

function readLines(file) {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("removes system messages and re-points their children at the surviving ancestor", async () => {
  const file = writeTranscript([
    { type: "session", id: "header", cwd: "/tmp" },
    { type: "message", id: "u1", parentId: "header", message: { role: "user", content: "hi" } },
    { type: "message", id: "s1", parentId: "u1", message: { role: "system", content: "prompt" } },
    { type: "message", id: "s2", parentId: "s1", message: { role: "system", content: "tools" } },
    { type: "message", id: "a1", parentId: "s2", message: { role: "assistant", content: "yo" } },
  ]);
  await forgetChatSystemPrompt(file);
  const entries = readLines(file);
  assert.deepEqual(entries.map((e) => e.id), ["header", "u1", "a1"]);
  const assistant = entries.find((e) => e.id === "a1");
  assert.equal(assistant.parentId, "u1", "跳过两层 system 后接到最近的存活祖先");
});

test("system messages without a string id are kept (old semantics)", async () => {
  const file = writeTranscript([
    { type: "session", id: "header" },
    { type: "message", id: 42, parentId: "header", message: { role: "system", content: "no string id" } },
  ]);
  await forgetChatSystemPrompt(file);
  const entries = readLines(file);
  assert.equal(entries.length, 2, "无字符串 id 的 system 条目不删");
});

test("keeps non-message entries byte-identical in meaning and preserves order", async () => {
  const file = writeTranscript([
    { type: "session", id: "header", cwd: "/tmp", version: 3 },
    { type: "model_change", id: "m1", parentId: "header", provider: "p", modelId: "x" },
  ]);
  await forgetChatSystemPrompt(file);
  const entries = readLines(file);
  assert.deepEqual(entries, [
    { type: "session", id: "header", cwd: "/tmp", version: 3 },
    { type: "model_change", id: "m1", parentId: "header", provider: "p", modelId: "x" },
  ]);
});

test("a damaged transcript throws and is left untouched", async () => {
  const file = join(dir, "damaged.jsonl");
  const original = '{"type":"session","id":"header"}\n{"broken\n';
  writeFileSync(file, original, "utf8");
  await assert.rejects(() => forgetChatSystemPrompt(file), /damaged/);
  assert.equal(readFileSync(file, "utf8"), original, "失败不得替换原文件");
});
