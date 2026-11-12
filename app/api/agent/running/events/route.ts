import { getRunningRpcSessionIds, subscribeRunningSessions } from "@/lib/rpc-manager";
import { getSessionListVersion } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

// GET /api/agent/running/events - SSE stream of the set of currently-running
// session ids. Pushes an update whenever any session starts or stops working,
// so the sidebar never has to poll.
export async function GET(req: Request) {
  let dispose = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let unsubscribe = () => {};
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        req.signal?.removeEventListener("abort", cleanup);
        try { controller.close(); } catch { /* already closed/cancelled */ }
      };
      dispose = cleanup;
      req.signal?.addEventListener("abort", cleanup);
      const encode = (data: unknown) => {
        if (closed) return false;
        const text = `data: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(text));
          return true;
        } catch {
          cleanup();
          return false;
        }
      };

      // Subscribe BEFORE taking the initial snapshot so no state change can slip
      // through the gap between snapshot and subscription. Every frame carries
      // the session-list version: renames/deletes/creates in other windows bump
      // it, letting connected sidebars refetch without waiting for focus.
      const nextUnsubscribe = subscribeRunningSessions((ids) => {
        encode({ type: "running", runningSessionIds: ids, sessionListVersion: getSessionListVersion() });
      });
      if (closed) nextUnsubscribe();
      else unsubscribe = nextUnsubscribe;

      // Initial snapshot so the client renders the correct state immediately.
      // (A duplicate frame here is harmless: the client just sets the same set.)
      encode({ type: "running", runningSessionIds: getRunningRpcSessionIds(), sessionListVersion: getSessionListVersion() });

      // Heartbeat keeps the connection alive through proxies/timeouts, and it must
      // carry the CURRENT snapshot rather than a bare SSE comment: the sidebar treats
      // this stream as authoritative for running state, so a half-open connection
      // (comments still flow, but a state change was lost) would leave the last
      // received set — and its spinner — on screen forever. A real `data:` frame
      // re-establishes the truth even when nothing changed server-side.
      if (!closed) heartbeat = setInterval(() => {
        if (closed) return;
        const sent = encode({ type: "running", runningSessionIds: getRunningRpcSessionIds(), sessionListVersion: getSessionListVersion() });
        if (!sent) return;
        // A trailing comment still keeps intermediaries from idling the socket.
        try { controller.enqueue(encoder.encode(":\n\n")); }
        catch { cleanup(); }
      }, 30_000);

    },
    cancel() {
      dispose();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
