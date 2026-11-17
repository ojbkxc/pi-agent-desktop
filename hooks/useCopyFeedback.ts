"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/clipboard";

/**
 * 复制反馈的共享实现：成功短暂显示「已复制」，失败短暂显示「复制失败」。
 *
 * 为什么需要它：`copyText` 在剪贴板被拒且 execCommand 兜底失败时会 reject
 * （`lib/clipboard.ts`）。直接 `.then(onSuccess)` 会让失败变成未处理的 rejection
 * 且按钮零反馈；裸 `setTimeout` 不带句柄又会让连点两次时前一个定时器提前复位后
 * 一个提示（state.md 审计 P2，全仓 9 处同款）。
 *
 * 语义：
 * - 每次 copy 前先清掉上一个复位定时器，再按结果重新计时；
 * - 失败也按同样时长复位，调用方不必自己管；
 * - 卸载时清掉定时器，避免对已卸载组件 setState；
 * - `copy` 永不 reject（两个回调都吃掉），调用方可安全地 `void copy(text)`。
 */
export interface CopyFeedback {
  /** 最近一次复制成功，正处于提示窗口内。 */
  copied: boolean;
  /** 最近一次复制失败，正处于提示窗口内。 */
  failed: boolean;
  /** 复制文本并驱动反馈；不会 reject。 */
  copy: (text: string) => Promise<void>;
}

export function useCopyFeedback(resetMs = 1500): CopyFeedback {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current !== null) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  // 卸载时清理，避免组件已卸载仍在 setState。
  useEffect(() => clearResetTimer, [clearResetTimer]);

  const copy = useCallback(
    (text: string) =>
      copyText(text).then(
        () => {
          clearResetTimer();
          setCopied(true);
          setFailed(false);
          resetTimerRef.current = setTimeout(() => {
            setCopied(false);
            resetTimerRef.current = null;
          }, resetMs);
        },
        () => {
          clearResetTimer();
          setFailed(true);
          setCopied(false);
          resetTimerRef.current = setTimeout(() => {
            setFailed(false);
            resetTimerRef.current = null;
          }, resetMs);
        },
      ),
    [clearResetTimer, resetMs],
  );

  return { copied, failed, copy };
}
