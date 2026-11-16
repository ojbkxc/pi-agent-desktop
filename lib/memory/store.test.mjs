import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 长期记忆磁盘存储：CRUD、上限、原子性。
 *
 * 全部用临时目录隔离；`agentDir` 用 `PI_AGENT_HOME` 之外的方式注入 —— store 的
 * `filePath` 选项就是唯一入口，无需改 env。
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const {
  MEMORY_MAX_ENTRIES,
  MEMORY_MAX_TEXT_BYTES,
  createMemoryStore,
  memoryFilePath,
  readMemoryFile,
  writeMemoryFile,
  normalizeMemoryText,
  normalizeMemoryTags,
  MemoryValidationError,
} = await jiti.import("./store.ts");

async function tempFile(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "pi-web", "memory.json");
}

const fixedClock = () => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
};

test("memoryFilePath 与 Pi Web 设置同源（<agent dir>/pi-web/memory.json）", () => {
  assert.equal(memoryFilePath("/agent"), join("/agent", "pi-web", "memory.json"));
  assert.equal(memoryFilePath(), memoryFilePath());
  assert.match(memoryFilePath(), /pi-web[\\/]memory\.json$/);
});

test("缺文件 → 空列表；写入后可读回，且落盘是 0600 的纯 JSON", async (t) => {
  const filePath = await tempFile(t);
  const store = createMemoryStore({ filePath, now: fixedClock(), newId: () => "id-1" });
  assert.deepEqual(store.list(), []);

  const entry = store.add({ text: "  user prefers pnpm  ", tags: ["pref", " "], sourceSessionId: "s-1" });
  assert.equal(entry.id, "id-1");
  assert.equal(entry.text, "user prefers pnpm");
  assert.deepEqual(entry.tags, ["pref"]);
  assert.equal(entry.sourceSessionId, "s-1");
  assert.equal(entry.createdAt, entry.updatedAt);
  assert.deepEqual(store.list(), [entry]);

  const raw = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.entries.length, 1);
  assert.equal(raw.entries[0].text, "user prefers pnpm");

  if (process.platform !== "win32") {
    assert.equal((await stat(filePath)).mode & 0o777, 0o600, "0600, private file");
  }
});

test("add → update → remove 的往返", async (t) => {
  const filePath = await tempFile(t);
  const now = fixedClock();
  const store = createMemoryStore({ filePath, now });
  const first = store.add({ text: "one" });
  store.add({ text: "two" });

  const updated = store.update(first.id, { text: "one (edited)", tags: ["x"] });
  assert.equal(updated.text, "one (edited)");
  assert.deepEqual(updated.tags, ["x"]);
  assert.equal(updated.createdAt, first.createdAt);
  assert.notEqual(updated.updatedAt, first.updatedAt);

  // 显式传空标签 = 清空 tags。
  const cleared = store.update(first.id, { tags: [] });
  assert.equal(cleared.tags, undefined);

  assert.equal(store.remove(first.id), true);
  assert.equal(store.remove(first.id), false, "第二次删除返回 false");
  assert.deepEqual(store.list().map((entry) => entry.text), ["two"]);
  assert.equal(store.update("missing", { text: "x" }), null);
});

test("update 什么都不给 → 校验错误；不认识的 id → null", async (t) => {
  const filePath = await tempFile(t);
  const store = createMemoryStore({ filePath });
  const entry = store.add({ text: "x" });
  assert.throws(() => store.update(entry.id, {}), MemoryValidationError);
  assert.equal(store.update("nope", { text: "y" }), null);
});

test("上限：单条 ≤ 4KB（UTF-8 字节，按中文计数）", async (t) => {
  const filePath = await tempFile(t);
  const store = createMemoryStore({ filePath });
  assert.throws(() => store.add({ text: "   " }), MemoryValidationError, "空文本拒绝");
  const ascii = "a".repeat(MEMORY_MAX_TEXT_BYTES);
  assert.equal(store.add({ text: ascii }).text.length, MEMORY_MAX_TEXT_BYTES, "恰好 4KB 通过");
  assert.throws(() => store.add({ text: `${ascii}b` }), /4096|at most/i, "超 1 字节拒绝");
  // 中文 3 字节：1366 个字符 = 4098 字节。
  assert.throws(() => store.add({ text: "中".repeat(1366) }), MemoryValidationError);
  assert.equal(store.add({ text: "中".repeat(1365) }).text.length, 1365);
});

test("上限：条目最多 200（满了拒绝新增，不静默淘汰）", async (t) => {
  const filePath = await tempFile(t);
  const store = createMemoryStore({ filePath });
  for (let index = 0; index < MEMORY_MAX_ENTRIES; index += 1) store.add({ text: `m${index}` });
  assert.equal(store.list().length, MEMORY_MAX_ENTRIES);
  assert.throws(() => store.add({ text: "overflow" }), /at most 200 entries/);
  assert.equal(store.list().length, MEMORY_MAX_ENTRIES, "失败不落盘");
  // 删除一条后可以再加。
  store.remove(store.list()[0].id);
  assert.equal(store.add({ text: "after delete" }).text, "after delete");
});

test("标签归一化：去空、去重、上限 10、单个 ≤ 64 字符", () => {
  assert.deepEqual(normalizeMemoryTags([" a ", "a", "", "b"]), ["a", "b"]);
  assert.deepEqual(normalizeMemoryTags([]), []);
  assert.equal(normalizeMemoryTags(undefined), undefined);
  assert.equal(normalizeMemoryTags(null), undefined);
  assert.throws(() => normalizeMemoryTags("nope"), MemoryValidationError);
  assert.throws(() => normalizeMemoryTags([1]), MemoryValidationError);
  assert.throws(() => normalizeMemoryTags(Array.from({ length: 11 }, (_, i) => `t${i}`)), /at most 10 tags/);
  assert.throws(() => normalizeMemoryTags(["x".repeat(65)]), /64 characters/);
  assert.deepEqual(normalizeMemoryTags(["x".repeat(64)]), ["x".repeat(64)]);
});

test("normalizeMemoryText：非字符串拒绝", () => {
  assert.throws(() => normalizeMemoryText(42), MemoryValidationError);
  assert.throws(() => normalizeMemoryText(undefined), MemoryValidationError);
  assert.equal(normalizeMemoryText("  ok  "), "ok");
});

test("坏 JSON / 版本不符 / 条目畸形 → 抛错而不是当空文件（避免下次写入抹掉记忆）", async (t) => {
  const filePath = await tempFile(t);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, "{ not json");
  const store = createMemoryStore({ filePath });
  assert.throws(() => store.list(), /Invalid memory file/);
  assert.throws(() => store.add({ text: "x" }), /Invalid memory file/);

  await writeFile(filePath, JSON.stringify({ version: 99, entries: [] }));
  assert.throws(() => readMemoryFile(filePath), /unsupported version/);

  await writeFile(filePath, JSON.stringify({ version: 1, entries: [{ id: 1 }] }));
  assert.throws(() => readMemoryFile(filePath), /entry 0 is malformed/);

  // 修好后能正常读写。
  writeMemoryFile({ version: 1, entries: [] }, filePath);
  assert.deepEqual(store.list(), []);
});

test("原子写：目录里不残留 tmp 文件，失败时旧文件仍在", async (t) => {
  const filePath = await tempFile(t);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(filePath, ".."), { recursive: true });
  const store = createMemoryStore({ filePath });
  store.add({ text: "kept" });
  const files = await readdir(join(filePath, ".."));
  assert.deepEqual(files, ["memory.json"], "没有 .tmp 残留");

  // 模拟写失败（rename 目标目录被替换成文件）：旧内容不被破坏。
  const original = await readFile(filePath, "utf8");
  const brokenPath = join(filePath, "..", "memory.json", "nested");
  const brokenStore = createMemoryStore({ filePath: brokenPath });
  assert.throws(() => brokenStore.add({ text: "nope" }));
  assert.equal(await readFile(filePath, "utf8"), original);
  assert.equal(JSON.parse(original).entries[0].text, "kept");
});

test("读-改-写：并发两路 add 都落盘（原子写串行化，最后文件含两条）", async (t) => {
  const filePath = await tempFile(t);
  // store 是同步 API，Node 单线程下天然串行；这里验证每次 add 都基于上一次的结果，
  // 而不是把旧文件整体覆盖。
  const a = createMemoryStore({ filePath });
  const b = createMemoryStore({ filePath });
  a.add({ text: "from a" });
  b.add({ text: "from b" });
  assert.deepEqual(a.list().map((entry) => entry.text).sort(), ["from a", "from b"]);
  assert.deepEqual(b.list().map((entry) => entry.text).sort(), ["from a", "from b"]);
});