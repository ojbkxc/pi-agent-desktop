import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { applyNetworkProxy } from "@/lib/network-proxy";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { startScheduler } from "@/lib/scheduled-tasks";
import { startAutofixSweepLoop } from "@/lib/autofix/runner";
import { startKeepalive } from "@/lib/keepalive";
import { startUnattendedSweepLoop } from "@/lib/agent-teams-unattended-runtime";
import { restartRelayFromConfig } from "@/lib/relay/runtime";
import { restartPublicAccessFromConfig } from "@/lib/public-access/runtime";

export function registerNodeInstrumentation(): void {
  configureHttpDispatcher();

  // 网络代理（设置 › 通用 › 网络代理）：把保存的档位写进 HTTP_PROXY / HTTPS_PROXY / NO_PROXY，
  // 再 force 重装 dispatcher —— node 的 fetch 不读系统代理，模型请求要走出去得靠这一步。
  // 必须排在 configureHttpDispatcher() 之后（这里要覆盖它在无代理环境下装的那个实例）。
  // 设置读不出来、系统探测失败都不该拦住启动，所以整段只记一行日志。
  void applyNetworkProxy().catch((error) => {
    console.error(
      "[network-proxy] could not apply the saved setting:",
      error instanceof Error ? error.message : error,
    );
  });

  // Scheduled tasks must fire without anyone having opened a page, and the
  // packaged app keeps this server alive while its window is hidden in the tray.
  if (process.env.PI_WEB_DISABLE_SCHEDULER !== "1") startScheduler();

  // 自动修 Bug 的任务接续：进程重启后把孤儿任务重新驱动（每 60s 扫一次，同一开关族）。
  if (process.env.PI_WEB_DISABLE_SCHEDULER !== "1") startAutofixSweepLoop();

  // Provider 中断自愈：扫描 ~/.pi/agent/pi-web/outages/ 里的挂起记录，按退避探测并在
  // 上游恢复后自动续跑（每 30s 扫一次；同一开关族）。懒加载调度器与 rpc-manager。
  if (process.env.PI_WEB_DISABLE_SCHEDULER !== "1") {
    void import("@/lib/outage/live")
      .then(({ startLiveOutageScheduler }) => startLiveOutageScheduler())
      .catch((error) => {
        console.error("[outage] scheduler did not start:", error instanceof Error ? error.message : error);
      });
  }

  // 挂机保活：每 15s 写心跳（外部 scripts/pi-supervisor.mjs 据此判假死）、重启后
  // 接续进度、把「待接续/被打断」记进 ~/.pi/agent/keepalive/。进程级崩溃后的拉起
  // 归外部守护脚本（本进程无法重启自己）。与调度同一开关族：测试/e2e 静默整段。
  if (process.env.PI_WEB_DISABLE_KEEPALIVE !== "1" && process.env.PI_WEB_DISABLE_SCHEDULER !== "1") {
    startKeepalive();
  }

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

  // Next evaluates a route's code on its first request, so the first
  // /api/sessions used to pay for importing the whole pi SDK, seconds on
  // Windows (#964). Start that import now, unawaited so register() stays fast:
  // it overlaps the browser opening, and the routes reuse Node's cached module.
  // A failure is left for the routes' own import to report.
  import("@earendil-works/pi-coding-agent").catch(() => {});
}
