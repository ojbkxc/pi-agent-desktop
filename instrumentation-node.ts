import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { startScheduler } from "@/lib/scheduled-tasks";
import { startUnattendedSweepLoop } from "@/lib/agent-teams-unattended-runtime";
import { restartRelayFromConfig } from "@/lib/relay/runtime";
import { restartPublicAccessFromConfig } from "@/lib/public-access/runtime";

export function registerNodeInstrumentation(): void {
  configureHttpDispatcher();

  // Scheduled tasks must fire without anyone having opened a page, and the
  // packaged app keeps this server alive while its window is hidden in the tray.
  if (process.env.PI_WEB_DISABLE_SCHEDULER !== "1") startScheduler();

  // 无人值守兜底：团队计划久等不批、成员执行失败时，提醒 lead 自己降级/重派/接管
  // （桌面不替 AI 做决定）。默认开，与调度同一开关族；小循环独立于用户的 Scheduled 列表。
  if (process.env.PI_WEB_DISABLE_SCHEDULER !== "1" && process.env.PI_WEB_DISABLE_TEAMS_FALLBACK !== "1") {
    startUnattendedSweepLoop();
  }

  // The relay connection (Settings › Remote relay) must also come up without a page:
  // a phone reaches this computer through it.
  if (process.env.PI_WEB_DISABLE_RELAY !== "1") {
    void restartRelayFromConfig().catch((error) => {
      console.error("[relay] could not start:", error instanceof Error ? error.message : error);
    });
  }

  // The Cloudflare tunnel (Settings › Public access) restores only when the user
  // turned on auto-start; it refuses to run without a web password. Tests and
  // e2e runs set PI_WEB_DISABLE_TUNNEL=1 so nothing dials out.
  if (process.env.PI_WEB_DISABLE_TUNNEL !== "1") {
    void restartPublicAccessFromConfig().catch((error) => {
      console.error("[public-access] could not start:", error instanceof Error ? error.message : error);
    });
  }

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);
}
