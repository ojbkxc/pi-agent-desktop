import type { SessionPushEvent } from "./web-push";

/**
 * Phone pushes for the states lib/web-push.ts's session events do not cover.
 *
 * Today that is one state: the user stopped a run. rpc-manager's completion
 * listener returns early on `outcome.status === "aborted"` (lib/rpc-manager.ts,
 * onAgentRunComplete), so a stop is the only run outcome that never reaches a
 * phone — and a phone that started the run from the Tasks page is exactly the
 * place that wants to know it really stopped. Wiring that branch is the
 * integrator's edit; this module owns the message and the failure policy.
 *
 * The sender is injectable so the unit test can assert the payload without a
 * push service, and the default one reuses lib/web-push.ts's notifier (the same
 * subscriptions, locales, VAPID keys and "gone" pruning as every other push).
 */

export type SessionPushSender = (
  sessionId: string,
  event: SessionPushEvent,
  sessionName?: string | null,
) => Promise<void>;

export interface SessionStopInfo {
  /** The live session's own title; null/omitted lets the notifier read the session file. */
  sessionName?: string | null;
  /** Optional one-line cause ("Stopped from the phone", an error note); capped by web-push. */
  detail?: string;
}

export type SessionStopNotifier = (sessionId: string, info?: SessionStopInfo) => Promise<void>;

/**
 * The same default tag as completion pushes (`pi-session-complete:<id>`): the
 * phone gets one current notification per session, so a later stop replaces an
 * earlier "waiting for you" instead of stacking another banner on the lock
 * screen.
 */
export function stopPushEvent(info: SessionStopInfo = {}): SessionPushEvent {
  const detail = info.detail?.trim();
  return detail ? { kind: "stopped", detail } : { kind: "stopped" };
}

/**
 * A notifier over an injected sender. Every failure is logged and swallowed:
 * a push is best-effort, and the run-stop path must not fail because a push
 * service is down (the caller is a notification hook, not the run itself).
 */
export function createSessionStopNotifier(send: SessionPushSender): SessionStopNotifier {
  return async (sessionId, info = {}) => {
    try {
      await send(sessionId, stopPushEvent(info), info.sessionName ?? undefined);
    } catch (error) {
      console.error("[pi-web] failed to send stop push:", error instanceof Error ? error.message : error);
    }
  };
}

const defaultSend: SessionPushSender = async (sessionId, event, sessionName) => {
  // Imported on first use: the unit test's mock sender never loads web-push,
  // and the server's module graph is unchanged.
  const { notifySessionEvent } = await import("./web-push");
  await notifySessionEvent(sessionId, event, sessionName);
};

/** Push "run stopped" for one session; never rejects. */
export const notifySessionStopped: SessionStopNotifier = createSessionStopNotifier(defaultSend);