import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

// d5-36：缓存淘汰是可注入时钟的纯行为，直接行为断言；在途去重与定时器清理
// 依赖原生 IPC 桩，用源码哨兵钉住。

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { pruneAppListCache, loadApps } = await jiti.import("./useFileContextMenu.ts");
assert.equal(typeof loadApps, "function", "hook 模块可加载（连带 desktop-menu/desktop-native 依赖链）");

const TTL = 5 * 60_000;

test("pruneAppListCache removes only expired entries (d5-36)", () => {
  const cache = new Map();
  cache.set("fresh", { apps: [], at: 10_000 + 1 });
  cache.set("stale", { apps: [], at: 10_000 });
  const now = 10_000 + TTL; // fresh 距今 TTL-1（< TTL）保留；stale 距今恰 TTL（>= TTL）淘汰。
  pruneAppListCache(now, cache);
  assert.deepEqual([...cache.keys()], ["fresh"]);
});

test("pruneAppListCache clears an empty map without throwing (d5-36)", () => {
  const cache = new Map();
  pruneAppListCache(0, cache);
  assert.equal(cache.size, 0);
});

test("the cache is pruned on write and in-flight requests are deduped (d5-36, sentinel)", async () => {
  const source = (await readFile(new URL("./useFileContextMenu.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  // 命中后写前淘汰：Map 有界，不再只读不删。
  assert.match(source, /pruneAppListCache\(now\);/);
  // 在途去重：同 key 并发共用同一 Promise，IPC 只发一次。
  assert.match(source, /const inFlight = appListInFlight\.get\(key\);/);
  assert.match(source, /appListInFlight\.set\(key, promise\);/);
  assert.match(source, /appListInFlight\.delete\(key\);/);
  // 快路径胜出时清掉 slow 定时器，不留 800ms 挂起定时器。
  assert.match(source, /\} finally \{\s*\n\s*clearTimeout\(timer\);/);
});
