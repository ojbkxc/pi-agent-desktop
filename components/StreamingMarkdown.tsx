"use client";

import { Streamdown } from "@lobehub/streamdown";
import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import { useReducedMotion } from "@/hooks/useStreamingMarkdown";
import { needsWholeMarkdownDocument } from "@/lib/streaming-markdown";
import { parseFenceBlock } from "@/lib/markdown-blocks";

const completionOptions = {
  htmlTags: false,
  inlineKatex: false,
  linkMode: "text-only",
} as const;

type Props = Omit<Options, "children"> & { children: string; isStreaming?: boolean };

/**
 * A streaming reply whose whole text is one fenced code block skips the
 * markdown engine: its language and code go straight to the fence renderer,
 * so a long fence is not re-parsed on every chunk (upstream #1589; the parse
 * of a large fence measured ~24 ms per chunk). Math fences and anything else
 * still go through the parser; a finished message renders exactly as before.
 */
function FenceOnlyMarkdown({ children, components, ...options }: Props) {
  const fence = parseFenceBlock(children);
  if (fence) {
    const code = components?.code;
    if (typeof code === "function") {
      const CodeComponent = code as (props: { className?: string; children?: ReactNode }) => ReactNode;
      return <CodeComponent className={`language-${fence.lang}`}>{fence.code}</CodeComponent>;
    }
    return (
      <pre>
        <code className={`language-${fence.lang}`}>{fence.code}</code>
      </pre>
    );
  }
  return <ReactMarkdown components={components} {...options}>{children}</ReactMarkdown>;
}

/** A headless stream engine; Pi still owns the syntax plugins and all widgets. */
function AnimatedMarkdown({ children, ...options }: Omit<Props, "isStreaming">) {
  const reducedMotion = useReducedMotion();
  // A reconnect or in-place edit can replace a stream. Remount its queue during
  // render so even the first paint cannot contain the previous answer's text.
  const [input, setInput] = useState({ text: children, generation: 0 });
  const generation = input.generation + (children.startsWith(input.text) ? 0 : 1);
  if (children !== input.text) setInput({ text: children, generation });
  if (reducedMotion) {
    return <ReactMarkdown {...options}>{children}</ReactMarkdown>;
  }

  return (
    <Streamdown
      {...options}
      key={generation}
      content={children}
      granularity="word"
      smoothing="realtime"
      remend={completionOptions}
    />
  );
}

export const StreamingMarkdown = memo(function StreamingMarkdown({ children, isStreaming, ...options }: Props) {
  // The fence-only bypass is checked first, so it serves the streaming path too:
  // a growing fence is the one document whose re-parse cost grows with its length.
  if (parseFenceBlock(children)) {
    return <FenceOnlyMarkdown {...options}>{children}</FenceOnlyMarkdown>;
  }
  if (!isStreaming || needsWholeMarkdownDocument(children)) {
    return <ReactMarkdown {...options}>{children}</ReactMarkdown>;
  }
  return <AnimatedMarkdown {...options}>{children}</AnimatedMarkdown>;
});
