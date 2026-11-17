"use client";

import { useEffect, useState } from "react";

/**
 * 每次墙钟采样：返回毫秒时间戳，初始为 `null`（首帧与 SSR 都不知道「现在」）。
 *
 * **为什么不用 `useState(Date.now)`**：渲染期调用 `Date.now` 违反 React 的纯度规则
 * （eslint 的 `react-hooks` 规则会直接判红），且服务端渲染与客户端水合会得到不同值。
 * 这里把采样放在 effect 里：首帧渲染是确定的（`null`），水合后立刻补一次真实时间。
 *
 * `intervalMs` 为 `null` / `0` 时不启动定时器并保持 `null`（调用方据此关闭倒计时）。
 */
export function useWallClock(intervalMs: number | null): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!intervalMs || intervalMs <= 0) {
      setNow(null);
      return;
    }
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}