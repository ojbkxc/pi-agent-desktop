"use client";

import { useEffect, useRef } from "react";
import { isImeComposing } from "@/lib/ime";
import {
  FOCUSABLE_SELECTOR,
  filterVisibleFocusables,
  isInRadixOverlay,
  isTopModal,
  pickInitialFocus,
  pushModal,
  removeModal,
  resolveOpener,
  resolveTabWrap,
  shouldRestoreFocus,
} from "@/lib/modal-focus";

/**
 * 对话框共用的「关闭 + 焦点管理」：
 * - Esc 关闭最上层模态（嵌套时一次只关一层）
 * - Tab / Shift+Tab 圈禁在传入的容器内
 * - 挂载时焦点进入对话框，卸载时归还打开它的元素
 *
 * 把返回的 ref 挂到对话框面板元素上（不是遮罩）。
 *
 * 三条与既有基建的约束（见 test-results/detail-audit/a11y.md）：
 * 1. Radix 浮层（Select.Portal / 菜单）渲染到 document.body，焦点落在浮层内时
 *    Tab 与 Esc 都放行给 Radix，否则 Settings 里的下拉一开就坏。
 * 2. 模态栈对外提供 `isModalOpen()`，让 Settings 的冒泡段 Esc（listenForPanelEscape）
 *    在有模态打开时退让，避免一次 Esc 先关外层。
 * 3. Esc 在此处 preventDefault + stopPropagation，避免冒泡到 window 的全局 Esc
 *    把运行中的 agent 停掉。
 */
export function useModalDismiss<T extends HTMLElement = HTMLDivElement>(
  onDismiss: () => void,
  enabled = true,
) {
  const containerRef = useRef<T | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // 打开前的焦点（opener）。**必须在渲染期捕获**：React 的 `autoFocus` 在 commit
  // 阶段（DOM 插入后）就移焦，早于任何 effect；等到 effect 里读 activeElement 时
  // 已经是面板内部的输入框，卸载时会把焦点「归还」给一个已被卸载的元素，焦点
  // 掉到 body（GoalCreateDialog / DirectoryPicker 实测回归）。
  // undefined = 本次打开尚未捕获；null = 捕获到「打开前没有任何焦点」。
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);
  if (!enabled) {
    openerRef.current = undefined;
  } else if (openerRef.current === undefined) {
    // 渲染期：新面板 DOM 尚未提交，activeElement 仍是触发元素。
    if (typeof document !== "undefined") {
      openerRef.current = document.activeElement as HTMLElement | null;
    }
  }

  useEffect(() => {
    if (!enabled) return;
    // SSR 安全：effect 只在浏览器执行，但显式挡一道，便于在测试替身里复用。
    if (typeof document === "undefined") return;

    const id = Symbol("modal");
    pushModal(id);

    const container = containerRef.current;
    // 渲染期捕获值优先；退化时用此刻的焦点，但两者都必须在面板外（见 resolveOpener）。
    // 不清空 ref：`enabled` 保持 true 的重渲染不得把面板内元素当成新的 opener；
    // 只有 `enabled` 变 false 时渲染期那条分支才会重置它。
    const previouslyFocused = resolveOpener(
      openerRef.current ?? null,
      document.activeElement as HTMLElement | null,
      container,
    );

    if (container && !container.contains(document.activeElement)) {
      const autofocus = container.querySelector<HTMLElement>("[data-autofocus]");
      const first = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      const target = pickInitialFocus(autofocus, first, container);
      if (target === container) container.tabIndex = -1;
      target.focus({ preventScroll: true });
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopModal(id) || event.defaultPrevented) return;

      if (event.key === "Escape") {
        if (isImeComposing(event)) return;
        // Radix 下拉自己处理 Esc：放行，否则会直接关掉整个模态。
        if (isInRadixOverlay(document.activeElement)) return;
        event.preventDefault();
        event.stopPropagation();
        onDismissRef.current();
        return;
      }

      if (event.key !== "Tab") return;
      const panel = containerRef.current;
      if (!panel) return;
      // Radix 浮层内的 Tab 由 Radix 管理，不能把焦点拉回面板。
      if (isInRadixOverlay(document.activeElement)) return;
      const active = document.activeElement as HTMLElement | null;
      const focusables = filterVisibleFocusables(
        Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)),
        active && panel.contains(active) ? active : null,
      );
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const activeIndex = active && panel.contains(active) ? focusables.indexOf(active) : -1;
      const wrap = resolveTabWrap(focusables.length, activeIndex, event.shiftKey);
      if (wrap === null) return;
      event.preventDefault();
      (wrap === "first" ? focusables[0] : focusables[focusables.length - 1]).focus();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      removeModal(id);
      // 只在焦点仍在模态内 / 已丢到 body 时归还，用户移到别处就不抢。
      if (shouldRestoreFocus(document, container)) {
        previouslyFocused?.focus?.({ preventScroll: true });
      }
    };
  }, [enabled]);

  return containerRef;
}

export { isModalOpen } from "@/lib/modal-focus";
