"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { StreamingStore } from "@/lib/streaming-message";

/**
 * 实时 tok/s 速度指示。
 *
 * 两个变体：
 * - `line`（默认）：输入框下方的独立一行（早期位置）。
 * - `inline`：塞进输入框底栏、紧跟上下文用量环 / 「自动压缩」旁边的那一小块——
 *   这是操作者实际要看的位置（和 pi 的 TUI footer 一致），不再单独占一行。
 *
 * 数据源是 StreamingStore 的 `streamingMs`（`start` 归零、每个 delta 推进）与累计
 * 流字符数（文本 + 思考 + 工具调用原始输入）。tok/s 用「累计字符 ÷ 4 ÷ 流式秒数」
 * 的口径：pi 的 usage 只在回合结束才可靠可得，流中没有每 chunk 的 token 数，
 * 字符 ÷ 4 是 BPE 在英文与 CJK 混合文本上的通行近似——把它当**量级**而不是账单。
 *
 * 渲染纪律（与 StreamingReply 同一条）：
 * - 每 500ms 采样一次，chunk 本身不触发本组件渲染；
 * - 非流式（`isStreaming=false`）整块不渲染，不占布局；
 * - 速度 < 1 tok/s 显示 `&lt; 1`，避免「0 tok/s」的假象；
 * - 时间基线取 `start` 的墙钟（`sinceRef`），速度 = 累计字符 / 4 / 已流式秒数，
 *   而不是「采样间隔内的字符」，后者在工具执行暂停时会乱跳。
 *
 * 为什么由它自己订阅 store 而不是让父组件先算好值：`ChatInput` 是 `memo` 的，注释
 * 明写「props 在流式期间保持不变」；父组件每 500ms 把速率写进 prop 会让整个输入框
 * 每半秒重渲染一次。这里传的是**稳定的 store 引用**，只有这一个小块会重渲染。
 */
export function StreamingRateLine({ store, variant = "line" }: { store: StreamingStore; variant?: "line" | "inline" }) {
  const { t } = useI18n();
  const [sample, setSample] = useState(() => measure(store));

  // 只在数字变了时提交状态：静默期（工具执行、长思考）字符不变，但 streamingMs
  // 仍在走——把它纳入比较，速率才会随时间平滑衰减，而不是钉在静默前一刻。
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (stopped) return;
      const next = measure(store);
      setSample((previous) => (
        next.chars === previous.chars
        && next.streaming === previous.streaming
        && next.streamingMs === previous.streamingMs
      ) ? previous : next);
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
      className={variant === "inline" ? "composer-rate-inline" : "composer-rate-line"}
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

/** 累计流字符数（扣除重连基线）：与真正到达的增量一致。 */
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
  // snapshot 已经带来的那部分不参与速率：分母从 snapshot 时刻起算，分子就得只数
  // 之后的增量，否则首采样是一个几乎全是虚高的数（实测 4000 字符 → 2000 tok/s）。
  const baseline = typeof state.baselineChars === "number" && state.baselineChars > 0 ? state.baselineChars : 0;
  return { streaming: true, chars: Math.max(0, chars - baseline), streamingMs: state.streamingMs };
}
