import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const source = (await readFile(new URL("./useResizablePanel.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

// 仓库没有 DOM 渲染器：hook 的监听/拖拽接线用本文件末尾的源码哨兵钉住；
// 决定「要不要持久化、上限恢复后回不回弹」的宽度提交规则抽成纯函数
// resolvePanelWidthCommit，这里用 jiti 加载真实模块直接验证（不复制公式自证）。
const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("..", import.meta.url)) },
  moduleCache: false,
});
const { resolvePanelWidthCommit } = await jiti.import("./useResizablePanel.ts");

const limits = (maxWidth) => ({ minWidth: 180, maxWidth });

test("vertical panels use vertical pointer movement, cursor, keys, and separator orientation", () => {
  assert.match(source, /axis === "vertical" \? event\.clientY : event\.clientX/);
  assert.match(source, /axis === "vertical" \? "row-resize" : "col-resize"/);
  assert.match(source, /axis === "vertical" \? "ArrowDown" : "ArrowRight"/);
  assert.match(source, /axis === "vertical" \? "ArrowUp" : "ArrowLeft"/);
  assert.match(source, /axis === "vertical" \? "horizontal" as const : "vertical" as const/);
});

test("resized values continue to persist and reset through the shared panel contract", () => {
  assert.match(source, /if \(plan\.persist\) writeStoredWidth\(storageKey, plan\.applied\)/);
  assert.match(source, /onDoubleClick: resetWidth/);
  assert.match(source, /event\.key === "Enter"/);
  assert.match(source, /window\.addEventListener\("resize", onResize\)/);
});

// ---------------------------------------------------------------------------
// 宽度提交规则（state.md P1：瞬态钳制不得写回用户设定）
// ---------------------------------------------------------------------------

test("恢复：小窗口下只钳制显示宽度，存储值原样保留（不写回）", () => {
  const plan = resolvePanelWidthCommit(260, "restore", 480, limits(220));
  assert.deepEqual(plan, { applied: 220, desired: 480, persist: false });
});

test("瞬态钳制不改变用户设定、不持久化；上限恢复后回弹到原值", () => {
  // 打开右侧面板把侧栏上限压到 220：显示 220，但用户设定仍是 480。
  const shrunk = resolvePanelWidthCommit(480, "reclamp", 480, limits(220));
  assert.deepEqual(shrunk, { applied: 220, desired: 480, persist: false });
  // 关闭右侧面板 / 拉宽窗口：上限回到 480，按用户设定回弹。
  const grown = resolvePanelWidthCommit(480, "reclamp", 220, limits(480));
  assert.deepEqual(grown, { applied: 480, desired: 480, persist: false });
});

test("窗口 resize 与打开/关闭面板同语义：只在显示层钳制", () => {
  const plan = resolvePanelWidthCommit(480, "viewport", 480, limits(220));
  assert.deepEqual(plan, { applied: 220, desired: 480, persist: false });
});

test("用户的拖拽 / 键盘 / 复位才更新设定并持久化", () => {
  assert.deepEqual(
    resolvePanelWidthCommit(480, "user", 300, limits(480)),
    { applied: 300, desired: 300, persist: true },
  );
  // 用户把宽度推到超出上限：持久化的是钳制后的可见宽度。
  assert.deepEqual(
    resolvePanelWidthCommit(300, "user", 900, limits(480)),
    { applied: 480, desired: 480, persist: true },
  );
});

test("最小宽度同样生效，非有限候选回退到最小宽度", () => {
  assert.deepEqual(
    resolvePanelWidthCommit(300, "user", 10, limits(480)),
    { applied: 180, desired: 180, persist: true },
  );
  const plan = resolvePanelWidthCommit(260, "restore", Number.NaN, limits(480));
  assert.equal(plan.applied, 180);
  assert.equal(plan.desired, 180);
  assert.equal(plan.persist, false);
});

// ---------------------------------------------------------------------------
// DOM 接线源码哨兵：非用户路径一律不写 localStorage，恢复路径不覆盖存储值。
// ---------------------------------------------------------------------------

test("瞬态路径与恢复路径在接线层不持久化", () => {
  assert.match(source, /commitWidth\(widthRef\.current, "reclamp"\)/);
  assert.match(source, /commitWidth\(widthRef\.current, "viewport"\)/);
  assert.match(source, /commitWidth\(candidate, "restore"\)/);
  // 旧实现：恢复时把钳制值写回存储。
  assert.doesNotMatch(source, /storedWidth !== restoredWidth/);
  assert.doesNotMatch(source, /writeStoredWidth\(storageKey, restoredWidth\)/);
});

test("只有用户操作的分支会写 localStorage", () => {
  // 一次函数声明 + 一次「plan.persist」条件调用，没有第二处裸写。
  const calls = [...source.matchAll(/writeStoredWidth\(/g)];
  assert.equal(calls.length, 2, "writeStoredWidth 只允许出现在声明与用户提交分支");
  assert.match(source, /if \(plan\.persist\) writeStoredWidth\(storageKey, plan\.applied\)/);
});