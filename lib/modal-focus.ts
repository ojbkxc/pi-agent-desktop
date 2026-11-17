/**
 * 模态焦点圈禁 / 模态栈的纯算法。
 *
 * 为什么单独成文件：仓库没有 DOM 测试渲染器（见 hooks/useModalDismiss.test.mjs
 * 顶部的说明），所以把「可聚焦元素过滤、Tab 回绕判定、模态栈查询、Radix 浮层
 * 放行、焦点归还条件」这些决定行为的判断抽成无副作用纯函数，直接单测；
 * `hooks/useModalDismiss.ts` 只负责 DOM 接线。
 *
 * 本文件不 import 任何东西，node --experimental-strip-types 可直接加载。
 */

/** 与 useModalDismiss 一致的可聚焦元素选择器。 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Radix 的 Select / 菜单浮层通过 Portal 渲染到 document.body，位于模态容器之外。
 * 焦点落进这些浮层时：
 * - Tab 必须放行（Radix 自己在浮层内管理焦点），否则下拉一打开就被判为「焦点逃逸」；
 * - Esc 必须放行（Radix 自己关下拉），否则会直接关掉整个模态。
 */
export const RADIX_OVERLAY_SELECTOR = [
  "[data-radix-popper-content-wrapper]",
  '[role="listbox"]',
  '[role="menu"]',
  "[data-radix-select-content]",
].join(", ");

/** 只声明 closest 的最小结构，测试可传替身。 */
interface ClosestLike {
  closest?(selector: string): unknown;
}

/** 该元素是否在 Radix 浮层内（含浮层自身）。 */
export function isInRadixOverlay(element: ClosestLike | null | undefined): boolean {
  if (!element || typeof element.closest !== "function") return false;
  return Boolean(element.closest(RADIX_OVERLAY_SELECTOR));
}

/** 只声明布局字段的最小结构：`offsetParent === null` 表示被 display:none 隐藏。 */
interface VisibilityLike {
  offsetParent?: unknown;
}

/**
 * 过滤出可见的可聚焦元素。当前焦点元素即便被隐藏也保留（用户可能正停在
 * 一个刚被折叠的分区里），与旧实现一致。
 */
export function filterVisibleFocusables<T extends VisibilityLike>(elements: readonly T[], active: T | null): T[] {
  return elements.filter((element) => element.offsetParent !== null || element === active);
}

/** Tab 回绕的落点：null 表示不拦截，交给浏览器默认行为。 */
export type TabWrapTarget = "first" | "last" | null;

/**
 * 计算一次 Tab / Shift+Tab 是否需要回绕。
 * - activeIndex 为 -1 表示焦点不在容器内：两个方向都拉回容器。
 * - 正向 Tab 从最后一个元素（或容器外）回到第一个。
 * - Shift+Tab 从第一个元素（或容器外）回到最后一个。
 */
export function resolveTabWrap(count: number, activeIndex: number, shiftKey: boolean): TabWrapTarget {
  if (count <= 0) return null;
  if (shiftKey) return activeIndex <= 0 ? "last" : null;
  return activeIndex === -1 || activeIndex >= count - 1 ? "first" : null;
}

/**
 * 打开模态时的初始焦点：优先 `[data-autofocus]`（危险确认框把它放在「取消」上），
 * 否则第一个可聚焦元素，再否则容器自身。
 */
export function pickInitialFocus<T>(autofocus: T | null, first: T | null, container: T): T {
  return autofocus ?? first ?? container;
}

/**
 * 关闭模态时是否归还焦点。只在焦点仍留在模态内、落到 body、或已经丢失时归还；
 * 用户中途把焦点移到别处（例如又打开了另一个对话框）就保持不动。
 */
interface ContainsLike {
  contains(other: unknown): boolean;
}

interface FocusRestoreDocument {
  readonly activeElement: unknown;
  readonly body: unknown;
}

export function shouldRestoreFocus(doc: FocusRestoreDocument, panel: ContainsLike | null): boolean {
  const active = doc.activeElement;
  if (active === null || active === undefined) return true;
  if (active === doc.body) return true;
  return panel ? panel.contains(active) : false;
}

/**
 * 决定关闭时把焦点还给谁。
 *
 * 为什么需要它：React 的 `autoFocus` 在 **commit 阶段**（DOM 插入后）就把焦点移进
 * 面板，早于 `useEffect`。若在 effect 里读 `document.activeElement`，拿到的是面板内
 * 那个输入框；卸载时「归还」给一个已被卸载的输入框，焦点会掉到 `<html>/body`（
 * GoalCreateDialog / DirectoryPicker 的实测回归）。所以调用方在**渲染期**（新面板
 * DOM 尚未提交，activeElement 仍是触发按钮）先捕获一次，作为权威值。
 *
 * - `capturedAtRender` 不在面板内 → 就是真实 opener，归还给它。
 * - 渲染期没捕获到（SSR/hydration 边界）→ 退而用 effect 时的焦点，但只接受面板外的。
 * - 两者都落在面板内（退化情况）→ 返回 null：宁可不归还，也不归还给面板内元素。
 */
export function resolveOpener<T>(
  capturedAtRender: T | null,
  activeAtEffect: T | null,
  panel: ContainsLike | null,
): T | null {
  const outside = (element: T | null): T | null => (
    element && (!panel || !panel.contains(element)) ? element : null
  );
  return outside(capturedAtRender) ?? outside(activeAtEffect);
}

// ---------------------------------------------------------------------------
// 模态栈：只有栈顶响应 Esc / Tab。挂在模块级而不是组件里，嵌套模态才能互相看见。
// ---------------------------------------------------------------------------

const modalStack: symbol[] = [];

/** 打开一层模态，返回它在本栈中的身份。 */
export function pushModal(id: symbol): void {
  modalStack.push(id);
}

/** 关闭一层模态（无论它是否仍在栈顶）。 */
export function removeModal(id: symbol): void {
  const index = modalStack.indexOf(id);
  if (index !== -1) modalStack.splice(index, 1);
}

/** 该层是否是当前最上层。 */
export function isTopModal(id: symbol): boolean {
  return modalStack[modalStack.length - 1] === id;
}

/**
 * 当前是否有 useModalDismiss 模态打开。
 *
 * 给 Settings 这类「冒泡段 Esc」面板用：它的 listenForPanelEscape 与模态
 * 同为 document 冒泡监听，注册顺序决定谁先跑；模态一打开，面板的 Esc 必须
 * 退让，否则一次 Esc 会先关掉 Settings、把模态留在最上层（a11y 审计 P1）。
 */
export function isModalOpen(): boolean {
  return modalStack.length > 0;
}

/** 仅供测试：清空模块级栈，避免用例之间互相污染。 */
export function resetModalStackForTests(): void {
  modalStack.length = 0;
}
