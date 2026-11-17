"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type PointerEvent,
} from "react";
import { clampPanelWidth } from "@/lib/panel-layout";

interface DragState {
  pointerId: number;
  startPosition: number;
  startWidth: number;
  target: HTMLDivElement;
  previousCursor: string;
  previousUserSelect: string;
}

interface UseResizablePanelOptions {
  ariaLabel: string;
  axis?: "horizontal" | "vertical";
  cssVariable: `--${string}`;
  defaultWidth: number;
  getDefaultWidth?: () => number;
  getMaxWidth: () => number;
  growthDirection: "left" | "right" | "up" | "down";
  maxWidth: number;
  minWidth: number;
  storageKey: string;
  widthRef: MutableRefObject<number>;
}

function readStoredWidth(storageKey: string): number | null {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return null;
    const parsed = Number.parseInt(stored, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredWidth(storageKey: string, width: number): void {
  try {
    window.localStorage.setItem(storageKey, String(width));
  } catch {
    // Resizing remains available when storage is unavailable.
  }
}

/**
 * 一次宽度提交「由谁发起」——决定要不要持久化，以及此刻宽度是用户的选择
 * 还是瞬态约束下的显示值。
 */
export type PanelWidthCommitCause = "restore" | "reclamp" | "viewport" | "user";

export interface PanelWidthCommit {
  /** 实际生效的宽度（已按当前上限钳制）。 */
  applied: number;
  /** 用户想要的宽度：只随用户操作 / 恢复变化，瞬态钳制不改变它。 */
  desired: number;
  /** 是否写回 localStorage——只有用户直接操作才写。 */
  persist: boolean;
}

/**
 * 面板宽度的提交规则（纯函数，行为测试见 useResizablePanel.test.mjs）。
 *
 * 为什么把「钳制」与「用户设定」分开：窗口变窄或打开右侧面板会让上限下降，
 * 这不是用户改了主意。旧实现把每次钳制结果都写回 localStorage——侧栏被压到
 * 220px 后，关面板 / 拉宽窗口都不回弹，重启仍是被钳值（state.md P1）。
 * - restore：读存储值 / 默认值，只钳制显示；原值留给以后回弹，绝不写回。
 * - reclamp / viewport：按当前上限重新计算显示宽度，desired 不动、不持久化；
 *   上限恢复后宽度自然回到用户原值。
 * - user：拖拽结束 / 方向键 / 双击复位——更新 desired 并持久化钳制后的宽度。
 */
export function resolvePanelWidthCommit(
  desiredBefore: number,
  cause: PanelWidthCommitCause,
  candidate: number,
  limits: { minWidth: number; maxWidth: number },
): PanelWidthCommit {
  const clamp = (width: number) => clampPanelWidth(width, limits.minWidth, limits.maxWidth);
  if (cause === "reclamp" || cause === "viewport") {
    return { applied: clamp(desiredBefore), desired: desiredBefore, persist: false };
  }
  if (cause === "restore") {
    // desired 保留未钳制的存储值：小窗口启动一次不能把 480 改写成 220。
    const desired = Number.isFinite(candidate) ? candidate : clamp(candidate);
    return { applied: clamp(candidate), desired, persist: false };
  }
  const applied = clamp(candidate);
  return { applied, desired: applied, persist: true };
}

export function useResizablePanel(options: UseResizablePanelOptions) {
  const {
    ariaLabel,
    axis = "horizontal",
    cssVariable,
    defaultWidth,
    getDefaultWidth,
    getMaxWidth,
    growthDirection,
    maxWidth,
    minWidth,
    storageKey,
    widthRef,
  } = options;
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const restoredRef = useRef(false);
  // 用户「想要的宽度」——只在拖拽 / 键盘 / 复位 / 恢复时更新；窗口与对侧面板
  // 引起的上限变化只影响 applied，上限回来后按它回弹（见 resolvePanelWidthCommit）。
  const desiredWidthRef = useRef(defaultWidth);
  const [width, setWidth] = useState(defaultWidth);
  const [isResizing, setIsResizing] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const effectiveMaxWidth = useCallback(
    () => Math.min(maxWidth, Math.max(minWidth, getMaxWidth())),
    [getMaxWidth, maxWidth, minWidth],
  );

  const clampWidth = useCallback(
    (candidate: number) => clampPanelWidth(candidate, minWidth, effectiveMaxWidth()),
    [effectiveMaxWidth, minWidth],
  );

  const applyLiveWidth = useCallback((nextWidth: number) => {
    widthRef.current = nextWidth;
    panelRef.current?.style.setProperty(cssVariable, `${nextWidth}px`);
  }, [cssVariable, widthRef]);

  const commitWidth = useCallback((candidate: number, cause: PanelWidthCommitCause = "reclamp") => {
    const plan = resolvePanelWidthCommit(
      desiredWidthRef.current,
      cause,
      candidate,
      { minWidth, maxWidth: effectiveMaxWidth() },
    );
    desiredWidthRef.current = plan.desired;
    applyLiveWidth(plan.applied);
    setWidth(plan.applied);
    // 只有用户直接操作（拖拽 / 键盘 / 复位）才写 localStorage。瞬态钳制与恢复
    // 路径的写回会把用户的选择永久改小（state.md P1）。
    if (plan.persist) writeStoredWidth(storageKey, plan.applied);
    return plan.applied;
  }, [applyLiveWidth, effectiveMaxWidth, minWidth, storageKey]);

  const restoreBodyState = useCallback((drag: DragState) => {
    document.body.style.cursor = drag.previousCursor;
    document.body.style.userSelect = drag.previousUserSelect;
  }, []);

  const finishResize = useCallback((pointerId: number) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    dragRef.current = null;
    restoreBodyState(drag);
    setIsResizing(false);
    commitWidth(widthRef.current, "user");

    try {
      if (drag.target.hasPointerCapture(pointerId)) {
        drag.target.releasePointerCapture(pointerId);
      }
    } catch {
      // The browser may have already released capture after pointer cancellation.
    }
  }, [commitWidth, restoreBodyState, widthRef]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const activeDrag = dragRef.current;
    if (activeDrag) finishResize(activeDrag.pointerId);

    const target = event.currentTarget;
    target.focus({ preventScroll: true });
    target.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startPosition: axis === "vertical" ? event.clientY : event.clientX,
      startWidth: widthRef.current,
      target,
      previousCursor: document.body.style.cursor,
      previousUserSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = axis === "vertical" ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
    setIsResizing(true);
  }, [axis, finishResize, widthRef]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons === 0) {
      finishResize(event.pointerId);
      return;
    }
    event.preventDefault();

    const direction = growthDirection === "right" || growthDirection === "down" ? 1 : -1;
    const position = axis === "vertical" ? event.clientY : event.clientX;
    const nextWidth = clampWidth(drag.startWidth + ((position - drag.startPosition) * direction));
    applyLiveWidth(nextWidth);
    event.currentTarget.setAttribute("aria-valuenow", String(nextWidth));
    event.currentTarget.setAttribute("aria-valuetext", `${nextWidth} px`);
  }, [applyLiveWidth, axis, clampWidth, finishResize, growthDirection]);

  const onPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    finishResize(event.pointerId);
  }, [finishResize]);

  const onPointerCancel = useCallback((event: PointerEvent<HTMLDivElement>) => {
    finishResize(event.pointerId);
  }, [finishResize]);

  const onLostPointerCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    finishResize(event.pointerId);
  }, [finishResize]);

  const resetWidth = useCallback(() => {
    const nextDefault = getDefaultWidth?.() ?? defaultWidth;
    commitWidth(nextDefault, "user");
  }, [commitWidth, defaultWidth, getDefaultWidth]);

  const reclampWidth = useCallback(() => {
    // 瞬态约束（窗口变窄 / 打开右侧面板）：按当前上限重算显示宽度，
    // 不改变用户设定，也不写 localStorage。
    commitWidth(widthRef.current, "reclamp");
  }, [commitWidth, widthRef]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 12;
    const positiveDirection = growthDirection === "right" || growthDirection === "down";
    const positiveKey = axis === "vertical" ? "ArrowDown" : "ArrowRight";
    const negativeKey = axis === "vertical" ? "ArrowUp" : "ArrowLeft";
    const growKey = positiveDirection ? positiveKey : negativeKey;
    const shrinkKey = positiveDirection ? negativeKey : positiveKey;

    if (event.key === growKey) {
      event.preventDefault();
      commitWidth(widthRef.current + step, "user");
    } else if (event.key === shrinkKey) {
      event.preventDefault();
      commitWidth(widthRef.current - step, "user");
    } else if (event.key === "Home") {
      event.preventDefault();
      commitWidth(minWidth, "user");
    } else if (event.key === "End") {
      event.preventDefault();
      commitWidth(effectiveMaxWidth(), "user");
    } else if (event.key === "Enter") {
      event.preventDefault();
      resetWidth();
    }
  }, [axis, commitWidth, effectiveMaxWidth, growthDirection, minWidth, resetWidth, widthRef]);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    const storedWidth = readStoredWidth(storageKey);
    const candidate = storedWidth ?? getDefaultWidth?.() ?? defaultWidth;
    // 恢复只钳制显示；存储值原样保留，小窗口启动一次不会把用户设定改小
    //（state.md P1：旧实现在这里把钳制值写回了 localStorage）。
    commitWidth(candidate, "restore");
  }, [commitWidth, defaultWidth, getDefaultWidth, storageKey]);

  useEffect(() => {
    if (!restoredRef.current) return;
    commitWidth(widthRef.current, "reclamp");

    const onResize = () => {
      // 视口变化只改变可用上限：按用户设定重算显示宽度，上限回来即回弹。
      commitWidth(widthRef.current, "viewport");
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [commitWidth, widthRef]);

  useEffect(() => {
    if (!isResizing) return;
    const cancelResize = () => {
      const drag = dragRef.current;
      if (drag) finishResize(drag.pointerId);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") cancelResize();
    };
    window.addEventListener("blur", cancelResize);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", cancelResize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [finishResize, isResizing]);

  useEffect(() => {
    return () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      restoreBodyState(drag);
    };
  }, [restoreBodyState]);

  return {
    isResizing,
    panelRef,
    reclampWidth,
    resetWidth,
    separatorProps: {
      "aria-label": ariaLabel,
      "aria-orientation": axis === "vertical" ? "horizontal" as const : "vertical" as const,
      "aria-valuemax": mounted ? effectiveMaxWidth() : maxWidth,
      "aria-valuemin": minWidth,
      "aria-valuenow": width,
      "aria-valuetext": `${width} px`,
      onDoubleClick: resetWidth,
      onKeyDown,
      onLostPointerCapture,
      onPointerCancel,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      role: "separator" as const,
      tabIndex: 0,
    },
    width,
  };
}
