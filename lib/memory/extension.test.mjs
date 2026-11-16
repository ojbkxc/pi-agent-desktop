import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 长期记忆扩展的接线：注册了什么、工具 execute 的返回形状、context_with_system 的有/无注入。
 *
 * 假 `pi`（记录 registerTool/on）+ 内存 store；存储本身已由 store.test.mjs 锁死，这里只验接线。
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const {
  MEMORY_EXTENSION_NAME,
  MEMORY_SECTION,
  MEMORY_TOOL_NAME,
  buildMemorySection,
  createMemoryExtension,
  injectMemoryIntoMessages,
} = await jiti.import("./extension.ts");
const { createMemoryStore } = await jiti.import("./store.ts");

function memStore(seed = []) {
  const map = new Map(seed.map((entry) => [entry.id, entry]));
  let nextId = seed.length + 1;
  const touch = (entry, timestamp) => ({ ...entry, updatedAt: timestamp });
  return {
    map,
    filePath: "(memory)",
    list: () => [...map.values()],
    add: ({ text, tags, sourceSessionId }) => {
      const timestamp = `2026-01-01T00:00:0${nextId}.000Z`;
      const entry = {
        id: `id-${nextId++}`,
        text: String(text).trim(),
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(tags && tags.length ? { tags } : {}),
        ...(sourceSessionId ? { sourceSessionId } : {}),
      };
      map.set(entry.id, entry);
      return entry;
    },
    update: (id, patch) => {
      const current = map.get(id);
      if (!current) return null;
      const next = { ...touch(current, "2026-01-02T00:00:00.000Z") };
      if (patch.text !== undefined) next.text = String(patch.text).trim();
      if (patch.tags !== undefined) {
        if (patch.tags.length) next.tags = patch.tags;
        else delete next.tags;
      }
      map.set(id, next);
      return next;
    },
    remove: (id) => map.delete(id),
  };
}

function makePi() {
  const tools = new Map();
  const handlers = new Map();
  return {
    tools,
    handlers,
    registerTool: (definition) => tools.set(definition.name, definition),
    on: (event, handler) => handlers.set(event, handler),
  };
}

function makeCtx(sessionId = "s-1") {
  return { sessionManager: { getSessionId: () => sessionId } };
}

const ENTRY = (over = {}) => ({
  id: "m1",
  text: "user prefers pnpm",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

function setup({ seed = [], ...options } = {}) {
  const pi = makePi();
  const store = memStore(seed);
  createMemoryExtension({ store, ...options }).factory(pi);
  return {
    pi,
    store,
    ctx: makeCtx(),
    execute(params) {
      return pi.tools.get(MEMORY_TOOL_NAME).execute("call-1", params, undefined, undefined, makeCtx());
    },
    context(messages) {
      return pi.handlers.get("context_with_system")({ type: "context_with_system", messages }, makeCtx());
    },
  };
}

const systemMessage = (sections = {}) => ({ role: "system", content: "", sections, timestamp: 1 });
const userMessage = (text) => ({ role: "user", content: text, timestamp: 2 });

// ───────────────────────── 注册面 ─────────────────────────

test("扩展名隐藏；只注册一个 memory 工具与 context_with_system", () => {
  const extension = createMemoryExtension({ store: memStore() });
  assert.equal(extension.name, MEMORY_EXTENSION_NAME);
  assert.equal(extension.hidden, true);
  const s = setup();
  assert.deepEqual([...s.pi.tools.keys()], [MEMORY_TOOL_NAME]);
  assert.deepEqual([...s.pi.handlers.keys()], ["context_with_system"], "只挂注入事件，不碰其它");
  const definition = s.pi.tools.get(MEMORY_TOOL_NAME);
  assert.equal(definition.label, "Memory");
  assert.ok(definition.description.length > 0);
  assert.equal(definition.parameters.type, "object");
  // typebox 1.x 把字面量联合序列化成 anyOf + const，而不是 type/enum。
  const actionSchema = JSON.stringify(definition.parameters.properties.action);
  for (const action of ["add", "list", "update", "delete"]) {
    assert.match(actionSchema, new RegExp(`"const":"${action}"`), action);
  }
});

// ───────────────────────── 工具 execute ─────────────────────────

test("add：落库并返回 details；来源会话取自 ctx", async () => {
  const s = setup();
  const result = await s.execute({ action: "add", text: "  likes dark mode  ", tags: ["pref"] });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /Saved memory id-1/);
  assert.ok(result.details, "execute 必须带 details");
  assert.equal(result.details.action, "add");
  assert.equal(result.details.total, 1);
  assert.equal(result.details.entries[0].text, "likes dark mode");
  assert.equal(result.details.entries[0].sourceSessionId, "s-1");
});

test("list：空态与全量，details.total 与 entries 对齐", async () => {
  const empty = setup();
  const none = await empty.execute({ action: "list" });
  assert.equal(none.content[0].text, "No memories.");
  assert.deepEqual(none.details, { action: "list", entries: [], total: 0 });

  const s = setup({ seed: [ENTRY(), ENTRY({ id: "m2", text: "second" })] });
  const result = await s.execute({ action: "list" });
  assert.match(result.content[0].text, /\[m1\] user prefers pnpm/);
  assert.match(result.content[0].text, /\[m2\] second/);
  assert.equal(result.details.total, 2);
  assert.equal(result.details.entries.length, 2);
});

test("update：改文本返回 details；未知 id → isError + details", async () => {
  const s = setup({ seed: [ENTRY()] });
  const updated = await s.execute({ action: "update", id: "m1", text: "user prefers bun" });
  assert.equal(updated.isError, undefined);
  assert.equal(updated.details.entries[0].text, "user prefers bun");
  assert.match(updated.content[0].text, /Updated memory m1/);

  const missing = await s.execute({ action: "update", id: "nope", text: "x" });
  assert.equal(missing.isError, true);
  assert.ok(missing.details, "错误返回也要带 details");
  assert.equal(missing.details.action, "update");
  assert.match(missing.content[0].text, /No memory with id nope/);
});

test("delete：删除返回 details；缺少 id / 未知 id → isError", async () => {
  const s = setup({ seed: [ENTRY()] });
  const removed = await s.execute({ action: "delete", id: "m1" });
  assert.equal(removed.isError, undefined);
  assert.equal(removed.details.total, 0);
  assert.ok(s.store.map.size === 0);

  const noId = await s.execute({ action: "delete" });
  assert.equal(noId.isError, true);
  assert.ok(noId.details);
  assert.match(noId.content[0].text, /id is required/);

  const again = await s.execute({ action: "delete", id: "m1" });
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /No memory with id m1/);
});

test("add 校验失败 → isError，不抛给模型循环", async () => {
  const s = setup();
  // 注入一个会抛校验错的 store（模拟 4KB 上限）。
  const failing = createMemoryExtension({
    store: { ...memStore(), add: () => { throw new Error("text must be at most 4096 bytes"); } },
  });
  const pi = makePi();
  failing.factory(pi);
  const result = await pi.tools.get(MEMORY_TOOL_NAME).execute("call-1", { action: "add", text: "x" }, undefined, undefined, makeCtx());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /4096/);
  assert.deepEqual(result.details, { action: "add", entries: [], total: 0 });
  // 未注入的原始 store 不受影响。
  assert.equal((await s.execute({ action: "list" })).details.total, 0);
});

// ───────────────────────── context_with_system ─────────────────────────

test("无记忆：不注入，返回 undefined（绝不吞 messages）", () => {
  const s = setup();
  const messages = [systemMessage(), userMessage("hi")];
  assert.equal(s.context(messages), undefined);
});

test("有记忆：段落写进首条 system 的 sections，其余消息原样保留", () => {
  const s = setup({ seed: [ENTRY(), ENTRY({ id: "m2", text: "second", updatedAt: "2026-01-02T00:00:00.000Z" })] });
  const messages = [systemMessage({ other: "<other>x</other>" }), userMessage("hi")];
  const result = s.context(messages);
  assert.ok(result);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].role, "system");
  assert.equal(result.messages[0].sections.other, "<other>x</other>", "既有 section 保留");
  const section = result.messages[0].sections[MEMORY_SECTION];
  assert.match(section, /Long-term memory/);
  assert.match(section, /user prefers pnpm/);
  assert.match(section, /second/);
  assert.match(section, /All 2 memories/);
  assert.deepEqual(result.messages[1], messages[1], "用户消息原样");
  // 不改原数组。
  assert.equal(messages[0].sections[MEMORY_SECTION], undefined);
});

test("首条不是 system：不注入（返回 undefined），不往用户消息里塞东西", () => {
  const s = setup({ seed: [ENTRY()] });
  const messages = [userMessage("hi")];
  assert.equal(s.context(messages), undefined);
});

test("注入限量：最多 30 条，按 updatedAt 倒序，并说明总数", () => {
  const seed = Array.from({ length: 45 }, (_, index) => ENTRY({
    id: `m${index}`,
    text: `memory ${index}`,
    updatedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
  }));
  const s = setup({ seed });
  const section = buildMemorySection(seed);
  const lines = section.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(lines.length, 30, "最多 30 条");
  assert.match(lines[0], /memory 44/, "最近更新的在最前");
  assert.doesNotMatch(section, /memory 0\b/, "第 31 条以后不进注入");
  assert.match(section, /Showing 30 of 45 memories/);

  const result = s.context([systemMessage(), userMessage("hi")]);
  assert.match(result.messages[0].sections[MEMORY_SECTION], /Showing 30 of 45/);
});

test("每条截断 200 字符 + 省略号；标签附在行尾", () => {
  const long = ENTRY({ text: "x".repeat(250), tags: ["tag-a"] });
  const section = buildMemorySection([long]);
  const line = section.split("\n").find((candidate) => candidate.startsWith("- "));
  // 200 字符 + '…' + ' [tag-a]'（2 前缀 + 201 摘要 + 8 标签 = 211；去掉前缀后 209）。
  assert.equal(Array.from(line.slice(2)).length, 209);
  assert.match(line, /… \[tag-a\]$/);
  // 200 字符内的中文按字符（不是字节）截断。
  const chinese = buildMemorySection([ENTRY({ text: "记".repeat(200) })]);
  assert.match(chinese, /- 记{200}$/);
});

test("读 store 失败 → 静默不注入（一条坏文件不拦请求）", () => {
  const pi = makePi();
  createMemoryExtension({
    store: { ...memStore(), list: () => { throw new Error("Invalid memory file"); } },
  }).factory(pi);
  const result = pi.handlers.get("context_with_system")({ type: "context_with_system", messages: [systemMessage()] }, makeCtx());
  assert.equal(result, undefined);
});

test("injectMemoryIntoMessages：section 为空时原样返回同一数组", () => {
  const messages = [systemMessage(), userMessage("hi")];
  assert.equal(injectMemoryIntoMessages(messages, null), messages);
});

test("buildMemorySection：空列表 → null", () => {
  assert.equal(buildMemorySection([]), null);
});

test("真实磁盘 store 也能接线（临时文件端到端）", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-ext-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createMemoryStore({ filePath: join(dir, "memory.json") });
  const pi = makePi();
  createMemoryExtension({ store }).factory(pi);
  const tool = pi.tools.get(MEMORY_TOOL_NAME);
  await tool.execute("c1", { action: "add", text: "remembered end to end" }, undefined, undefined, makeCtx("s-9"));
  const result = pi.handlers.get("context_with_system")({ type: "context_with_system", messages: [systemMessage()] }, makeCtx());
  assert.match(result.messages[0].sections[MEMORY_SECTION], /remembered end to end/);
});