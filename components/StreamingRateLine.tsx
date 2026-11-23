"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { StreamingStore } from "@/lib/streaming-message";

/**
 * 输入框下方的实时 tok/s 速度条。
 *
 * 数据源是 StreamingStore 的 `streamingMs`（`start` 归零、每个 delta 推进）与累计
 * 流字符数（文本 + 思考 + 工具调用原始输入）。tok/s 用「累计字符 ÷ 4 ÷ 流式秒数」
 * 的口径：pi 的 usage 只在回合结束才可靠可得，流中没有每 chunk 的 token 数，
 * 字符 ÷ 4 是 BPE 在英文与 CJK 混合文本上的通行近似——把它当**量级**而不是账单。
 *
 * 渲染纪律（与 StreamingReply 同一条）：
 * - 每 500ms 采样一次，chunk 本身不触发本组件渲染；
 * - 非流式（`isStreaming=false`）整行不渲染，不占布局；
 * - 速度 < 1 tok/s 显示 `&lt; 1`，避免「0 tok/s」的假象；
 * - 时间基线取 `start` 的墙钟（`sinceRef`），速度 = 累计字符 / 4 / 已流式秒数，
 *   而不是「采样间隔内的字符」，后者在工具执行暂停时会乱跳。
 */
export function StreamingRateLine({ store }: { store: StreamingStore }) {
  const { t } = useI18n();
  const [sample, setSample] = useState(() => measure(store));
  const sinceRef = useRef<number | null>(null);

  // 只在数字变了时提交状态：静默期（工具执行、长思考）不清零也不闪。
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (stopped) return;
      const next = measure(store);
      setSample((previous) =>
        next.chars === previous.chars && next.streaming === previous.streaming
          ? previous
          : next,
      );
      if (next.streaming) sinceRef.current ??= Date.now() - next.streamingMs;
      else sinceRef.current = null;
      timer = setTimeout(tick, 500);
    };
    timer = setTimeout(tick, 500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [store]);

  if (!sample.streaming) return null;
  const seconds = Math.max(sample.streamingMs / 1000, 0.5);
  const tokens = sample.chars / 4;
  const rate = tokens / seconds;
  const label = rate < 1 ? "< 1" : String(Math.round(rate));
  return (
    <div
      className="composer-rate-line"
      role="status"
      aria-label={t("chat.streamRate", { value: label })}
      title={t("chat.streamRateHint")}
    >
      <span className="composer-rate-dot" aria-hidden="true" />
      <span className="composer-rate-value">{label}</span>
      <span className="composer-rate-unit">tok/s</span>
    </div>
  );
}

interface RateSample {
  streaming: boolean;
  chars: number;
  /** 本轮流式累计毫秒（store 维护，不受 React 渲染时机影响）。 */
  streamingMs: number;
}

/** 累计流字符数：文本 + 思考 + 工具调用的原始输入，与真正到达的增量一致。 */
function measure(store: StreamingStore): RateSample {
  const state = store.getState();
  if (!state.isStreaming || !state.streamingMessage) {
    return { streaming: false, chars: 0, streamingMs: 0 };
  }
  let chars = 0;
  for (const block of state.streamingMessage.content) {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "thinking") chars += block.thinking.length;
    else if (block.type === "toolCall") chars += (block.rawInput ?? "").length;
  }
  return { streaming: true, chars, streamingMs: state.streamingMs };
}
