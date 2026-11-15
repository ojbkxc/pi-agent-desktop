/**
 * 自动修 Bug 的事件总线（SSE 用）。
 *
 * 挂在 globalThis 上：路由处理器（SSE / POST）与 runner 可能是不同的 module graph
 * （Next 分别打包），模块级 Set 会变成两个 Set（同 scheduled-tasks/events.ts）。
 */
import type { AutofixEvent } from "./types";

type Listener = (event: AutofixEvent) => void;

const LISTENERS_KEY = Symbol.for("pi-web:autofix-listeners");

function listeners(): Set<Listener> {
  const holder = globalThis as unknown as Record<symbol, Set<Listener> | undefined>;
  return (holder[LISTENERS_KEY] ??= new Set<Listener>());
}

export function subscribeAutofixEvents(listener: Listener): () => void {
  listeners().add(listener);
  return () => {
    listeners().delete(listener);
  };
}

export function emitAutofixEvent(event: AutofixEvent): void {
  for (const listener of listeners()) {
    try {
      listener(event);
    } catch {
      // 一个坏订阅者不能拖死其它订阅者。
    }
  }
}
