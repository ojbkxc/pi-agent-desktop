import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./ScheduledView.tsx", import.meta.url), "utf8");
const { englishMessages } = await createJiti(import.meta.url).import("../../lib/i18n/locale-plugins.ts");

test("scheduler owner notice explains the lease and offers only safe takeover", async () => {
  assert.match(source, /schedulerOwnerInfo/);
  assert.match(source, /const ownerTakeoverReady = Boolean\(schedulerOwnerInfo && \(!schedulerOwnerInfo\.fresh \|\| !schedulerOwnerInfo\.alive\)\)/);
  assert.match(source, /scheduledApi\.takeoverScheduler\(\)/);
  assert.match(source, /refreshScheduledTasks\(\)/);
  assert.match(source, /ownerTakeoverReady &&/);
  assert.equal(englishMessages["scheduled.takeOver"], "Take over");
});

test("the delete confirmation portals to body so the page stacking context cannot cap it", () => {
  // css.md 审计 P2：`.scheduled-view` 自身是 absolute + --z-sticky 的层叠上下文，
  // 确认框留在里面时任何 z-index 都封顶在 30，顶栏（--z-chrome）在模态期间仍可点。
  assert.match(source, /import \{ createPortal \} from "react-dom"/);
  assert.match(source, /confirmDelete && typeof document !== "undefined" && createPortal\(/);
  assert.match(source, /document\.body,\s*\n\s*\)\}/);
  // 删除确认原有的共享模态接线保持不变（portal 化不改 hook 调用）。
  assert.match(source, /const dialogRef = useModalDismiss<HTMLDivElement>\(onCancel\)/);
  assert.match(source, /className="scheduled-dialog-backdrop"/);
});

test("the page-level Escape guard yields while a modal is open", () => {
  // React 合成事件按「组件树」冒泡而不是 DOM 树：删除确认 portal 到 body 后仍是本组件
  // 的 React 子节点，对话框内的 Esc 会先经过页面级守卫。守卫若一律 preventDefault，
  // useModalDismiss 会因 event.defaultPrevented 跳过 Esc，确认框关不掉（verify-browser
  // F5 实测回归）。语义在 React 合成事件层，静态 DOM / 无渲染器测试测不出，故做源码哨兵。
  assert.match(source, /import \{ isModalOpen \} from "@\/lib\/modal-focus"/);
  assert.match(source, /if \(event\.key === "Escape" && !isModalOpen\(\)\) event\.preventDefault\(\);/);
});
