import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { applyNetworkProxy } from "@/lib/network-proxy";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { startScheduler } from "@/lib/scheduled-tasks";
import { startAutofixSweepLoop } from "@/lib/autofix/runner";
import { startCampaignSweep } from "@/lib/campaign/runner";
import { startKeepalive } from "@/lib/keepalive";
import { startUnattendedSweepLoop } from "@/lib/agent-teams-unattended-runtime";
import { restartRelayFromConfig } from "@/lib/relay/runtime";
import { restartPublicAccessFromConfig } from "@/lib/public-access/runtime";

/**
 * 启动分段计时。
 *
 * 为什么需要：桌面壳有个「事件循环被阻塞 N 秒」的看门狗，实测每次启动打两条
 * （3.5–15 秒），而 Next 报 `Ready in 0ms` 之后到 public-access 第一次输出之间有 **2.8 秒
 * 零日志**的空档（profile 拿不到——进程被 SIGKILL 时来不及写盘）。这段时间全落在下面这一串
 * 同步 `start*()` 调用里，但没有任何一处记录它自己花了多久。
 *
 * 所以给每一段打一条：`instrumentation: <name> took N ms`，只在超过 50ms 时打，正常启动
 * 安静，慢启动一眼看出是谁。埋点本身是纯计时，不影响行为。
 */
function timed<T>(name: string, run: () => T): T {
  const startedAt = Date.now();
  try {
    return run();
  } finally {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= 50) console.error(`[Pi Agent] instrumentation: ${name} took ${elapsed} ms`);
  }
}

/** 异步版的同一件事（不 await，只在它自己完成时记账）。 */
function timedAsync(name: string, run: () => Promise<unknown>): void {
  const startedAt = Date.now();
  void run()
    .catch(() => undefined)
    .finally(() => {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= 50) console.error(`[Pi Agent] instrumentation: ${name} took ${elapsed} ms`);
    });
}

export function registerNodeInstrumentation(): void {
  timed("http-dispatcher", () => configureHttpDispatcher());

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
  if (process.env.PI_WEB_DISABLE_SCHEDULER !== "1") timed("scheduler", () => startScheduler());

  // 自动修 Bug 的任务接续：进程重启后把孤儿任务重新驱动（每 60s 扫一次，同一开关族）。
  if (process.env.PI_WEB_DISABLE_SCHEDULER !== "1") timed("autofix-sweep", () => startAutofixSweepLoop());

  // 长时自主项目战役（campaign）的接续：进程重启后把孤儿战役重新驱动，到点的
  // Provider 中断也在这里续跑（每 60s 扫一次，同一开关族）。
  if (process.env.PI_WEB_DISABLE_SCHEDULER !== "1") timed("campaign-sweep", () => startCampaignSweep());

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
    timed("keepalive", () => startKeepalive());
  }

  // 无人值守兜底：团队计划久等不批、成员执行失败时，提醒 lead 自己降级/重派/接管
  // （桌面不替 AI 做决定）。默认开，与调度同一开关族；小循环独立于用户的 Scheduled 列表。
  if (process.env.PI_WEB_DISABLE_SCHEDULER !== "1" && process.env.PI_WEB_DISABLE_TEAMS_FALLBACK !== "1") {
    timed("unattended-sweep", () => startUnattendedSweepLoop());
  }

  // /goal 的「按计划重复」：间隔可能长达 1d，等待空档里没有任何会话事件（agent_settled
  // 只在一轮跑完时触发），会话会先被 idle 驱逐 —— 必须有一条进程级 tick 按 nextRunAt
  // 把下一轮投出去。同一开关族；只扫 `intervalMs > 0` 的目标，连续续跑不受影响。
  if (process.env.PI_WEB_DISABLE_SCHEDULER !== "1") {
    void import("@/lib/goal/goal-repeat")
      .then(async ({ startGoalRepeatSchedulerLoop, buildDefaultGoalRepeatDeps }) => {
        startGoalRepeatSchedulerLoop(await buildDefaultGoalRepeatDeps());
      })
      .catch((error) => {
        console.error("[goal-repeat] scheduler did not start:", error instanceof Error ? error.message : error);
      });
  }

  // The relay connection (Settings › Remote relay) must also come up without a page:
  // a phone reaches this computer through it.
  if (process.env.PI_WEB_DISABLE_RELAY !== "1") {
    timedAsync("relay", () => restartRelayFromConfig().catch((error) => {
      console.error("[relay] could not start:", error instanceof Error ? error.message : error);
    }));
  }

  // The Cloudflare tunnel (Settings › Public access) restores only when the user
  // turned on auto-start; it refuses to run without a web password. Tests and
  // e2e runs set PI_WEB_DISABLE_TUNNEL=1 so nothing dials out.
  if (process.env.PI_WEB_DISABLE_TUNNEL !== "1") {
    timedAsync("public-access", () => restartPublicAccessFromConfig().catch((error) => {
      console.error("[public-access] could not start:", error instanceof Error ? error.message : error);
    }));
  }

  // 后台命令（bash_background）：上个进程遗留的 `running` 记录随进程一起死了，
  // 这里结算成 interrupted —— 否则 UI 会把它们永远显示成「还在跑」。纯本地文件操作，
  // 与调度开关族无关（即使调度静默也要结算，否则状态是错的）。
  // 惰性 import：service → runtime → pi-coding-agent（getShellConfig），
  // 顶层引入会把整个 SDK 拖进 register()，而它必须返回得快（下方就有一条预热 import 的注释）。
  void import("@/lib/background-jobs/service")
    .then(({ initBackgroundJobs }) => {
      const settled = initBackgroundJobs();
      if (settled.length > 0) console.log(`[pi-web] 结算了 ${settled.length} 条遗留的后台命令记录`);
    })
    .catch((error) => {
      console.error("[pi-web] 后台命令记录结算失败:", error instanceof Error ? error.message : error);
    });

  // 常驻会话（pin）：liveness provider 只活在进程内，重启即全部消失。
  // 这里是「重启后把 pin 补回来」的第二道保险（第一道是扩展的 session_start）。
  // store 也是静态资源，但同样走惰性 import 以保持 register() 轻。
  void import("@/lib/pinned-sessions/store")
    .then(({ ensurePinnedRegistrations }) => {
      const { pinned } = ensurePinnedRegistrations();
      if (pinned.length > 0) console.log(`[pi-web] 已恢复 ${pinned.length} 个常驻会话`);
    })
    .catch((error) => {
      console.error("[pi-web] 常驻会话注册失败:", error instanceof Error ? error.message : error);
    });

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
