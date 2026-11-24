import { readTeamQuotaLimits } from "./agent-teams-swimlane-store";

/**
 * 把桌面侧的团队配额同步给 pi-team（同一进程里的 env），让两套闸门同源。
 *
 * 为什么需要（团队计数审计 P1-3）：上游 `pi-team` 的 `checkSpawnLimits` 每次现读
 * `process.env.PI_TEAM_MAX_GLOBAL_WORKERS` / `PI_TEAM_MAX_MEMBERS`，缺省 32 / 12；而桌面
 * 自己那套 `tryReserveTeamWorkerSlot` 用的是设置项（默认 64 / 16，且 `0` = 不限）。
 * 两套上限各算各的，于是出现最难解释的一种失败：面板显示还有余量 → 点派发 →
 * `LIMIT_EXCEEDED: global worker limit reached (32)`。
 *
 * 语义映射（上游 `positiveIntFromEnv` 只接受正整数）：
 * - 桌面 `0`（不限）→ 给上游一个足够大的数。上游没有「不限」语义，`0` 会被当成非法值
 *   **回落到 32**——那正是「我用不限，怎么还被 32 拦住」的成因。
 * - 其它值原样同步。
 *
 * 幂等、只改这两个键，不碰别的 env。
 */
export const PI_TEAM_UNLIMITED_WORKERS = 1_000_000;

export interface PiTeamQuotaEnvSync {
  globalWorkers: number;
  maxMembers: number;
}

function toUpstreamLimit(desktopLimit: number): number {
  // 0 或负数 = 不限（见 parseTeamQuotaLimit）；上游只认正整数，所以换成一个够大的值。
  return desktopLimit > 0 ? desktopLimit : PI_TEAM_UNLIMITED_WORKERS;
}

/**
 * 把当前配额写进 `process.env`。返回实际写给上游的两个值（测试与诊断用）。
 *
 * 只写不读：调用方（成员派发路径）负责在每次要 spawn 之前调它，这样改了设置不必重启。
 */
export function syncPiTeamQuotaEnv(
  env: NodeJS.ProcessEnv = process.env,
  limits: { perTeamLimit: number; globalLimit: number } = readTeamQuotaLimits(env),
): PiTeamQuotaEnvSync {
  const sync = {
    globalWorkers: toUpstreamLimit(limits.globalLimit),
    maxMembers: toUpstreamLimit(limits.perTeamLimit),
  };
  env.PI_TEAM_MAX_GLOBAL_WORKERS = String(sync.globalWorkers);
  env.PI_TEAM_MAX_MEMBERS = String(sync.maxMembers);
  return sync;
}
