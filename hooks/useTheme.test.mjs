import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

// d5-34：系统主题监听是进程单例（useSyncExternalStore 的 store 侧），行为无法在
// node --test 里驱动——这里钉住「结构上可拆卸」：监听有具名 handler、拆卸口存在
// 且成对移除全部三个监听。

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const themeModule = await jiti.import("./useTheme.ts");
assert.equal(typeof themeModule.useTheme, "function", "hook 可加载");
// 拆卸口可调用（node 无 window/document：systemListening=false → 早退，不抛）。
assert.equal(typeof themeModule.releaseSystemListeners, "function");
themeModule.releaseSystemListeners();

const source = (await readFile(new URL("./useTheme.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("the visibilitychange listener is a named module function, not anonymous (d5-34)", () => {
  assert.match(source, /function handleVisibilityChange\(\): void \{/);
  assert.match(source, /document\.addEventListener\("visibilitychange", handleVisibilityChange\);/);
  assert.doesNotMatch(source, /addEventListener\("visibilitychange", \(\) => \{/);
});

test("releaseSystemListeners removes every system listener it registered (d5-34)", () => {
  assert.match(source, /systemThemeQuery\?\.removeEventListener\("change", syncAutoThemeFromSystem\);/);
  assert.match(source, /window\.removeEventListener\("focus", syncAutoThemeFromSystem\);/);
  assert.match(source, /document\.removeEventListener\("visibilitychange", handleVisibilityChange\);/);
  assert.match(source, /systemThemeQuery = null;\s*\n\s*systemListening = false;/);
  // 单飞闸门仍在：未注册时不做任何事。
  assert.match(source, /function releaseSystemListeners\(\): void \{\s*\n\s*if \(!systemListening\) return;/);
});

test("the system listener registration keeps its single-flight gate (d5-34)", () => {
  assert.match(source, /if \(systemListening \|\| typeof window === "undefined" \|\| !window\.matchMedia\) return;/);
  assert.match(source, /systemThemeQuery = mql;\s*\n\s*systemListening = true;/);
});
