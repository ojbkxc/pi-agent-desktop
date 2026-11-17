import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FOCUSABLE_SELECTOR,
  RADIX_OVERLAY_SELECTOR,
  filterVisibleFocusables,
  isInRadixOverlay,
  isModalOpen,
  isTopModal,
  pickInitialFocus,
  pushModal,
  removeModal,
  resetModalStackForTests,
  resolveOpener,
  resolveTabWrap,
  shouldRestoreFocus,
} from "../lib/modal-focus.ts";

// ---------------------------------------------------------------------------
// 纯函数行为测试。
//
// 仓库没有 DOM 测试渲染器（无 jsdom / testing-library，也不允许为一条测试
// 引入依赖），所以 useModalDismiss 的 DOM 接线部分用源码哨兵兜底（本文件
// 末尾），而所有决定行为的判断——可聚焦过滤、Tab 回绕、初始焦点、归还条件、
// 模态栈——都抽到 lib/modal-focus.ts 里在这里直接验证。
// ---------------------------------------------------------------------------

test("Tab 从最后一个元素正向回绕到第一个", () => {
  assert.equal(resolveTabWrap(3, 2, false), "first");
});

test("Tab 在中间元素不拦截，交给浏览器", () => {
  assert.equal(resolveTabWrap(3, 1, false), null);
  assert.equal(resolveTabWrap(3, 0, false), null);
});

test("Shift+Tab 从第一个元素反向回绕到最后一个", () => {
  assert.equal(resolveTabWrap(3, 0, true), "last");
});

test("Shift+Tab 在中间元素不拦截", () => {
  assert.equal(resolveTabWrap(3, 1, true), null);
  assert.equal(resolveTabWrap(3, 2, true), null);
});

test("焦点不在容器内时两个方向都被拉回容器", () => {
  // activeIndex 为 -1：焦点在 body / 背景控件上。
  assert.equal(resolveTabWrap(3, -1, false), "first");
  assert.equal(resolveTabWrap(3, -1, true), "last");
});

test("单个可聚焦元素时 Tab 与 Shift+Tab 都回绕到它自己", () => {
  assert.equal(resolveTabWrap(1, 0, false), "first");
  assert.equal(resolveTabWrap(1, 0, true), "last");
});

test("没有可聚焦元素时不回绕（容器自身接管 Tab）", () => {
  assert.equal(resolveTabWrap(0, -1, false), null);
  assert.equal(resolveTabWrap(0, -1, true), null);
});

test("初始焦点优先 data-autofocus，其次第一个可聚焦元素，最后容器本身", () => {
  const cancel = { name: "cancel" };
  const first = { name: "first" };
  const container = { name: "container" };
  assert.equal(pickInitialFocus(cancel, first, container), cancel);
  assert.equal(pickInitialFocus(null, first, container), first);
  assert.equal(pickInitialFocus(null, null, container), container);
});

test("可见性过滤保留可见元素，也保留当前焦点元素", () => {
  const visible = { offsetParent: {} };
  const hidden = { offsetParent: null };
  const hiddenButActive = { offsetParent: null };
  assert.deepEqual(
    filterVisibleFocusables([visible, hidden, hiddenButActive], hiddenButActive),
    [visible, hiddenButActive],
  );
  assert.deepEqual(filterVisibleFocusables([visible, hidden], null), [visible]);
});

test("Radix 浮层内（含浮层自身）判定为放行", () => {
  const inside = { closest: (selector) => selector === RADIX_OVERLAY_SELECTOR ? {} : null };
  assert.equal(isInRadixOverlay(inside), true);
  const outside = { closest: () => null };
  assert.equal(isInRadixOverlay(outside), false);
  assert.equal(isInRadixOverlay(null), false);
  // 没有 closest 的替身不抛。
  assert.equal(isInRadixOverlay({}), false);
});

test("Radix 选择器覆盖 Select.Portal 实际渲染的几种标记", () => {
  // AppSelect.tsx 的 Select.Portal 产物；菜单/列表也走同一判定。
  for (const marker of ["[data-radix-popper-content-wrapper]", '[role="listbox"]', '[role="menu"]', "[data-radix-select-content]"]) {
    assert.ok(RADIX_OVERLAY_SELECTOR.includes(marker), `missing ${marker}`);
  }
});

test("归还焦点：焦点在模态内、落到 body 或丢失时归还，用户移到别处则不抢", () => {
  const panel = { contains: (other) => other === "inside" };
  const body = { name: "body" };
  assert.equal(shouldRestoreFocus({ activeElement: "inside", body }, panel), true);
  assert.equal(shouldRestoreFocus({ activeElement: body, body }, panel), true);
  assert.equal(shouldRestoreFocus({ activeElement: null, body }, panel), true);
  assert.equal(shouldRestoreFocus({ activeElement: "elsewhere", body }, panel), false);
  // 容器已卸载（ref 为 null）：焦点在 body 时仍归还给 opener。
  assert.equal(shouldRestoreFocus({ activeElement: body, body }, null), true);
  assert.equal(shouldRestoreFocus({ activeElement: "inside", body }, null), false);
});

test("opener 以渲染期捕获为准：autoFocus 抢先时仍归还给真实触发按钮", () => {
  // 复现 GoalCreateDialog：渲染期焦点在 /goal 按钮；
  // 到 effect 时 autoFocus 已把焦点移进面板内的输入框。
  const goalButton = { name: "/goal button" };
  const inputInside = { name: "condition input" };
  const panel = { contains: (other) => other === inputInside };
  assert.equal(
    resolveOpener(goalButton, inputInside, panel),
    goalButton,
    "effect 时的面板内焦点不得当成 opener",
  );
});

test("渲染期未捕获（SSR/hydration 边界）时回退到 effect 焦点，且仍须在面板外", () => {
  const goalButton = { name: "/goal button" };
  const inputInside = { name: "condition input" };
  const panel = { contains: (other) => other === inputInside };
  assert.equal(resolveOpener(null, goalButton, panel), goalButton, "退化路径仍能拿到面板外的触发元素");
  // 两者都落在面板内（退化情况）：宁可不归还，也不归还给面板内元素。
  assert.equal(resolveOpener(null, inputInside, panel), null);
  assert.equal(resolveOpener(inputInside, inputInside, panel), null);
  // 打开前没有任何焦点：null（不归还）。
  assert.equal(resolveOpener(null, null, panel), null);
});

test("模态栈：只有栈顶响应，弹出/移除后栈顶随之变化", () => {
  resetModalStackForTests();
  assert.equal(isModalOpen(), false);
  const outer = Symbol("outer");
  const inner = Symbol("inner");
  pushModal(outer);
  assert.equal(isModalOpen(), true);
  assert.equal(isTopModal(outer), true);
  pushModal(inner);
  assert.equal(isTopModal(outer), false);
  assert.equal(isTopModal(inner), true);
  removeModal(inner);
  assert.equal(isTopModal(outer), true);
  removeModal(outer);
  assert.equal(isModalOpen(), false);
  // 移除不在栈内的 id 不抛。
  assert.doesNotThrow(() => removeModal(Symbol("gone")));
});

test("FOCUSABLE_SELECTOR 保留原语义（含 tabindex=-1 排除）", () => {
  assert.ok(FOCUSABLE_SELECTOR.includes("button:not([disabled])"));
  assert.ok(FOCUSABLE_SELECTOR.includes('[tabindex]:not([tabindex="-1"])'));
});

// ---------------------------------------------------------------------------
// DOM 接线源码哨兵：真实 DOM 行为无法在 node --test 里跑，锁住接线形状，
// 防止后续改动把纯函数接线摘掉（或让 Esc 重新冒泡到全局 abort）。
// ---------------------------------------------------------------------------

const hookSource = readFileSync(new URL("./useModalDismiss.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const stackedSource = readFileSync(new URL("../lib/stacked-dialog.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("hook 的 Esc 在关闭前 preventDefault + stopPropagation，不再停掉运行中的 agent", () => {
  assert.match(hookSource, /event\.key === "Escape"/);
  assert.match(hookSource, /event\.preventDefault\(\);\s*\n\s*event\.stopPropagation\(\);\s*\n\s*onDismissRef\.current\(\);/);
});

test("hook 在 Radix 浮层内放行 Tab 与 Esc", () => {
  // Esc 与 Tab 两条路径都先查 isInRadixOverlay，否则下拉一开就坏。
  assert.match(hookSource, /if \(isInRadixOverlay\(document\.activeElement\)\) return;[\s\S]*onDismissRef\.current\(\)/);
  assert.match(hookSource, /event\.key !== "Tab"[\s\S]*if \(isInRadixOverlay\(document\.activeElement\)\) return;/);
});

test("hook 使用纯函数做回绕 / 初始焦点 / 归还判断", () => {
  assert.match(hookSource, /resolveTabWrap\(/);
  assert.match(hookSource, /pickInitialFocus\(/);
  assert.match(hookSource, /shouldRestoreFocus\(/);
  assert.match(hookSource, /pushModal\(id\)/);
  assert.match(hookSource, /removeModal\(id\)/);
  assert.match(hookSource, /isTopModal\(id\)/);
});

test("hook 在渲染期捕获 opener，不让 autoFocus 抢走的焦点被当成 opener", () => {
  // 关键接线：捕获必须在渲染 body（effect 之前），且只在本次打开尚未捕获时取一次。
  assert.match(hookSource, /openerRef = useRef<HTMLElement \| null \| undefined>\(undefined\)/);
  assert.match(hookSource, /\} else if \(openerRef\.current === undefined\) \{[\s\S]*?openerRef\.current = document\.activeElement as HTMLElement \| null;/);
  assert.match(hookSource, /resolveOpener\(/);
  // autoFocus 抢先时，effect 时的 activeElement 在容器内：resolveOpener 必须优先渲染期值。
  assert.match(hookSource, /resolveOpener\(\s*\n\s*openerRef\.current \?\? null,\s*\n\s*document\.activeElement as HTMLElement \| null,\s*\n\s*container,\s*\n\s*\)/);
});

test("hook 在 SSR 下安全（document 缺失时直接返回）", () => {
  assert.match(hookSource, /typeof document === "undefined"/);
});

test("Settings 的冒泡段 Esc 在模态打开时退让", () => {
  assert.match(stackedSource, /isModalOpen\(\)/);
  assert.match(stackedSource, /if \(isModalOpen\(\)\) return;/);
});

test("hook 对外导出 isModalOpen，供 Settings 等外层面板查询", () => {
  assert.match(hookSource, /export \{ isModalOpen \} from "@\/lib\/modal-focus"/);
});
