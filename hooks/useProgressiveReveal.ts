"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** 打开列表时先挂载的行数；每次读者接近末尾再追加一页。 */
export const REVEAL_PAGE_SIZE = 40;
/** 目标行仍在视口下方这么多像素时，就预先挂载下一页。 */
const REVEAL_PREFETCH_MARGIN = "0px 0px 480px 0px";

/**
 * 把一长串「最新在上」的列表按页渐进挂载（对齐 cc-haha 的 useProgressiveReveal）。
 *
 * 团队的通信历史在整个 run 期间持续增长，且每条正文行都要渲染 Markdown；一次性全挂载
 * 会让打开动作卡顿（553 条消息约 250ms、约 1.3 万 DOM 节点），而工作台每秒一次的时钟会
 * 在面板打开的整段时间里反复重渲染这些行。现在视口之下的行随滚动接近才挂载；别处展示的
 * 计数仍描述整个列表（本 hook 只负责「挂载多少行」，不做过滤）。
 *
 * `resetKey` 在列表**含义**变化时（换过滤器、换成员）从第一页重来，而不是仅在列表增长时。
 */
export function useProgressiveReveal(total: number, resetKey: string) {
  const [revealed, setRevealed] = useState({ key: resetKey, limit: REVEAL_PAGE_SIZE });
  // 在渲染期重置而不是只读默认值，这样回到先前看过的列表也从头一页开始（同 cc-haha）。
  if (revealed.key !== resetKey) setRevealed({ key: resetKey, limit: REVEAL_PAGE_SIZE });
  const limit = revealed.key === resetKey ? revealed.limit : REVEAL_PAGE_SIZE;
  const hasMore = total > limit;
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  /**
   * 运行外壳都有 IntersectionObserver；没有它（或测试环境）时调用方渲染一个按钮，
   * 让列表仍可翻页，而不是静默停在第一页。
   */
  const [canAutoReveal] = useState(() => typeof IntersectionObserver === "function");

  const showMore = useCallback(() => {
    setRevealed((current) => ({
      key: resetKey,
      limit: (current.key === resetKey ? current.limit : REVEAL_PAGE_SIZE) + REVEAL_PAGE_SIZE,
    }));
  }, [resetKey]);
  /** 挂载到包含第 `index` 行在内的整页（查找跳转用）。 */
  const revealThrough = useCallback((index: number) => {
    const needed = (Math.floor(index / REVEAL_PAGE_SIZE) + 1) * REVEAL_PAGE_SIZE;
    setRevealed((current) => {
      const currentLimit = current.key === resetKey ? current.limit : REVEAL_PAGE_SIZE;
      return currentLimit >= needed ? current : { key: resetKey, limit: needed };
    });
  }, [resetKey]);

  useEffect(() => {
    if (!canAutoReveal || !hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) showMore();
      },
      { root: scrollRootRef.current, rootMargin: REVEAL_PREFETCH_MARGIN },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // 每翻一页后重新 observe 是让高面板持续填满的关键：observer 只在变化时上报，
    // 一页之后仍处于范围内的哨兵否则永远不会再请求下一页。
  }, [canAutoReveal, hasMore, limit, showMore]);

  return { limit, hasMore, showMore, revealThrough, canAutoReveal, scrollRootRef, sentinelRef };
}
