import { subscribeAutofixEvents } from "@/lib/autofix/events";

export const dynamic = "force-dynamic";

// GET /api/autofix/events —— 任务变化的 SSE 流（只发「变了」，客户端重新拉列表）。
export async function GET(req: Request) {
  let dispose = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe = () => {};
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        req.signal?.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      dispose = cleanup;
      req.signal?.addEventListener("abort", cleanup);
      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };
      unsubscribe = subscribeAutofixEvents(send);
      // 立即给一帧，让 EventSource 的 readyState 尽快进入 OPEN。
      send({ type: "hello" });
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          cleanup();
        }
      }, 30_000);
      heartbeat.unref?.();
    },
    cancel() {
      dispose();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
