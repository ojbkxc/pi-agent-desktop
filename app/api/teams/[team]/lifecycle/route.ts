import { NextResponse } from "next/server";
import { getLifecycle, resolveTeamHost } from "pi-team";
import { teamDirFor } from "@/lib/agent-teams-swimlane-store";
import {
  readTeamConfig,
  readLifecycleSnapshot,
  removeTeamDirectory,
  runTeamLifecycleAction,
  type LifecycleSnapshotEntry,
  type TeamActionDeps,
  type TeamInstanceCleanup,
  type TeamLifecycleAction,
} from "@/lib/agent-teams-team-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/teams/[team]/lifecycle —— 停止 / 回收团队。
 *
 * body: { action: "stop" | "reclaim" }
 * - stop：逐成员 release(tombstone:false)，保留 sessionFile，之后可复活；
 * - reclaim：先逐成员停止并校验回执，全部成功才删团队目录（不可逆）。
 *
 * [team] 是**目录名**（sanitize 后）；生命周期 registry 的 key 是 config.json 的
 * **原始团队名**——两者不同，混用会「停止成功但什么都没停」。
 */

const LIFECYCLE_GLOBAL_KEY = "__piTeamLifecycles";
const BUS_GLOBAL_KEY = "__piTeamBuses";

/**
 * 本进程是否已有该团队的生命周期实例。
 *
 * 不能拿 getLifecycle 当探测：它**会创建**一个空实例（随后 release 静默失效，表现为
 * 「停止成功但什么都没停」）。这里直接看 pi-team 的进程级 registry。
 */
function hasLifecycleInstance(rawTeamName: string): boolean {
  const registry = (globalThis as Record<string, unknown>)[LIFECYCLE_GLOBAL_KEY];
  return registry instanceof Map && registry.has(rawTeamName);
}

/**
 * 宿主侧复刻 pi-team **未从根导出**的 `dropLifecycle` / `dropBus`。
 *
 * 两者实现都只有两行：`registry.get(name)?.dispose(); registry.delete(name)`。
 * 注册表本体是 globalThis 上的两个 Map——`__piTeamLifecycles` 与 `__piTeamBuses`
 * （见 pi-team 的 teamLifecycle.js / teamBus.js，常量 LIFECYCLE_GLOBAL_KEY / BUS_GLOBAL_KEY），
 * 键都是**原始团队名**。
 *
 * ⚠️ 这是复刻：一旦 pi-team 从根导出 dropLifecycle / dropBus，应改为直接调用官方实现。
 *
 * 回收（目录已删）后必须清，否则同名团队再建会**复用旧实例**（可能已 dispose、状态陈旧）。
 * best-effort：dispose 抛错也照样删键；一个注册表失败不影响另一个，也绝不影响「目录已删」。
 */
function dropTeamInstances(rawTeamName: string): TeamInstanceCleanup {
  const result: TeamInstanceCleanup = { lifecycle: false, bus: false };
  const targets = [
    [LIFECYCLE_GLOBAL_KEY, "lifecycle"],
    [BUS_GLOBAL_KEY, "bus"],
  ] as const;
  for (const [globalKey, slot] of targets) {
    try {
      const registry = (globalThis as Record<string, unknown>)[globalKey];
      if (!(registry instanceof Map)) continue;
      const instance = registry.get(rawTeamName) as { dispose?: () => void } | undefined;
      // bus 的 dispose() 会清 pending 计时器与 waiter（团队已回收，安全）；即便它抛错也只记原因、仍删键。
      try {
        instance?.dispose?.();
      } catch {
        // 忽略：dispose 失败不阻止删键。
      }
      result[slot] = registry.has(rawTeamName);
      registry.delete(rawTeamName);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
  }
  return result;
}

const deps: TeamActionDeps = {
  readTeamConfig: (teamDirName) => readTeamConfig(teamDirName, teamDirFor),
  readLifecycle: (teamDirName) => readLifecycleSnapshot(teamDirName, teamDirFor),
  hasLifecycleInstance,
  async release(rawTeamName, memberName): Promise<LifecycleSnapshotEntry> {
    // 实例已由上一步确认存在，getLifecycle 返回既有实例，不会新建。
    // host 传 resolveTeamHost()：实例存在时该参数被忽略。
    const lifecycle = getLifecycle(rawTeamName, resolveTeamHost());
    return await lifecycle.release(memberName, { tombstone: false });
  },
  removeTeamDir: (teamDirName) => removeTeamDirectory(teamDirName, teamDirFor),
  dropInstances: (rawTeamName) => Promise.resolve(dropTeamInstances(rawTeamName)),
  async probeRunning(sessionId: string): Promise<boolean> {
    // 惰性 import：lib/rpc-manager 会拖进 pi SDK，不能在纯模块里静态引入。
    // 会话不存在 / 从未派发 → getRpcSession 返回 undefined → 视为已停（false）。
    const { getRpcSession } = await import("@/lib/rpc-manager");
    return getRpcSession(sessionId)?.isRunning() ?? false;
  },
};

function parseAction(value: unknown): TeamLifecycleAction | null {
  return value === "stop" || value === "reclaim" ? value : null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ team: string }> },
) {
  const { team } = await params;

  let body: { action?: unknown };
  try {
    body = await req.json() as { action?: unknown };
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const action = parseAction(body?.action);
  if (!action) {
    return NextResponse.json({ error: "action 必须是 stop 或 reclaim" }, { status: 400 });
  }

  const teamDirName = decodeURIComponent(team);
  const result = await runTeamLifecycleAction(deps, { teamDirName, action });

  // 团队不存在 → 404；其余失败（实例不在、成员停止失败）→ 409，逐条 results 如实带出。
  const status = result.error === "团队不存在" ? 404 : result.ok ? 200 : 409;
  return NextResponse.json(result, { status, headers: { "Cache-Control": "no-store" } });
}