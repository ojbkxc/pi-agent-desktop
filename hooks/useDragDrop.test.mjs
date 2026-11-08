import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

// d5-35：hook 的行为全在事件回调与窗口监听里，node --test 无法渲染——
// 用 jiti 加载回归 + 源码哨兵钉住两道防线（leave 的文件类型判定 + dragend/drop 兜底）。

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { useDragDrop } = await jiti.import("./useDragDrop.ts");
assert.equal(typeof useDragDrop, "function", "hook 可加载");

const source = (await readFile(new URL("./useDragDrop.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("dragleave ignores non-file drags so the file-drag counter stays balanced (d5-35)", () => {
  // 旧实现 leave 无条件递减：页内文本拖动的 leave 会把文件拖拽的计数拖成失衡。
  assert.match(source, /const handleDragLeave = useCallback\(\(e: React\.DragEvent\) => \{\s*\n\s*\/\/ d5-35[\s\S]*?if \(!hasDraggedFiles\(e\)\) return;/);
});

test("a window-level dragend/drop fallback clears a stuck overlay (d5-35)", () => {
  // 拖拽期间源节点被重渲染/移除时收不到配对 leave → 窗口级 dragend/drop 一到即清零。
  assert.match(source, /useEffect\(\(\) => \{\s*\n\s*if \(!isDragOver\) return;/);
  assert.match(source, /window\.addEventListener\("dragend", reset\);/);
  assert.match(source, /window\.addEventListener\("drop", reset\);/);
  assert.match(source, /window\.removeEventListener\("dragend", reset\);/);
  assert.match(source, /window\.removeEventListener\("drop", reset\);/);
});
