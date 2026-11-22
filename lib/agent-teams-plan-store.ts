/**
 * B3 计划卡——**磁盘读取（服务端专用）**。
 *
 * 直接读 `~/.pi/agent/teams/<dir>/plan.json`（`teamDirFor` 与 pi-team 的
 * sanitizeName 对齐），投影成客户端要的 `TeamPlanView`。与仓库其它读盘点一致：
 * **不 import pi-team 包**（其 exports 不含内部模块），按同名规则直接读盘，
 * 与 `lib/agent-teams-unattended-store.ts:303` 的做法同源。
 *
 * 缺文件 / 损坏 / state 不在已知枚举 → 一律返回 null（界面当作「没有计划」）。
 * 客户端组件不要 import 本文件（含 node:fs）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { teamDirFor } from "./agent-teams-swimlane-store";
import {
  isPlanState,
  type PlanMemberView,
  type PlanRuntimeView,
  type PlanTaskView,
  type TeamPlanView,
} from "./agent-teams-plan";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;
const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function parseRuntime(raw: unknown): PlanRuntimeView | null {
  if (!isRecord(raw)) return null;
  const providerId = asString(raw.providerId);
  const modelId = asString(raw.modelId);
  if (!providerId || !modelId) return null;
  const effortLevel = asString(raw.effortLevel);
  return { providerId, modelId, ...(effortLevel ? { effortLevel } : {}) };
}

/**
 * 成员投影。
 *
 * 两条**不静默丢弃**的口径（都修自真实反馈的「批准按钮永远是灰的」）：
 * - `runtime` 缺失/残缺时填 `unknown/unknown` 这个显式占位，而不是把成员整条丢掉。
 *   丢掉成员会让任务的 ownerId 指向一个「不存在的成员」，`derivePlanReview` 判定
 *   `hasUnassignedTasks`，批准按钮永久禁用；而用户看不到这个成员，也就无法在卡里修它。
 *   `isUsableRuntime` 认得这对占位值，所以界面上它是「未知」而不是一个能用的模型。
 * - `name` 缺失时用 id 兜底：同理，宁可渲染一条可修的行，也不要让成员凭空消失。
 */
function parseMembers(raw: unknown): PlanMemberView[] {
  if (!Array.isArray(raw)) return [];
  const members: PlanMemberView[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = asString(item.id);
    if (!id) continue; // 没有 id 的行无法被编辑/指派，跳过是唯一选择
    const name = asString(item.name) ?? id;
    const runtime = parseRuntime(item.runtime) ?? { providerId: "unknown", modelId: "unknown" };
    const difficulty = item.difficulty;
    members.push({
      id,
      name,
      agentType: asString(item.agentType) ?? "general-purpose",
      prompt: asString(item.prompt) ?? "",
      runtime,
      ...(asString(item.reason) ? { reason: asString(item.reason)! } : {}),
      ...(difficulty === "low" || difficulty === "medium" || difficulty === "high"
        ? { difficulty }
        : {}),
    });
  }
  return members;
}

function parseTasks(raw: unknown): PlanTaskView[] {
  if (!Array.isArray(raw)) return [];
  const tasks: PlanTaskView[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = asString(item.id);
    const subject = asString(item.subject);
    if (!id || !subject) continue;
    const ownerId = asString(item.ownerId);
    const dependencies = Array.isArray(item.dependencies)
      ? item.dependencies.filter((dep): dep is string => typeof dep === "string")
      : [];
    tasks.push({
      id,
      subject,
      dependencies,
      ...(asString(item.description) ? { description: asString(item.description)! } : {}),
      ...(ownerId ? { ownerId } : {}),
    });
  }
  return tasks;
}

/**
 * 读一个团队的计划视图。不存在 / 解析失败 / state 未知 → null。
 * `teamName` 参数是 URL 里的团队名（可为原始名或 sanitize 后的目录名，二者都能定位）。
 */
export async function readTeamPlanView(teamName: string): Promise<TeamPlanView | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(teamDirFor(teamName), "plan.json"), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;

  const planId = asString(raw.planId);
  const sessionId = asString(raw.sessionId);
  const incarnationId = asString(raw.incarnationId);
  const revision = asNumber(raw.revision);
  if (!planId || !sessionId || !incarnationId || revision === null) return null;
  if (!isPlanState(raw.state)) return null;

  const approvedSnapshotRaw = isRecord(raw.approvedSnapshot) ? raw.approvedSnapshot : null;
  const snapshotRevision = approvedSnapshotRaw ? asNumber(approvedSnapshotRaw.revision) : null;
  const snapshotRequestId = approvedSnapshotRaw ? asString(approvedSnapshotRaw.requestId) : null;

  const launchRaw = isRecord(raw.launch) ? raw.launch : null;
  const launchStatus = launchRaw?.status;
  const launch: TeamPlanView["launch"] =
    launchRaw && (launchStatus === "pending" || launchStatus === "running" || launchStatus === "failed")
      ? {
          status: launchStatus,
          ...(asString(launchRaw.error) ? { error: asString(launchRaw.error)! } : {}),
        }
      : undefined;

  return {
    planId,
    sessionId,
    // 展示名优先用 plan.json 记录的原始团队名（中文名不再显示成目录名），目录名兜底。
    teamName: asString(raw.teamName) ?? teamName,
    incarnationId,
    state: raw.state,
    revision,
    leaderRuntime: parseRuntime(raw.leaderRuntime),
    members: parseMembers(raw.members),
    tasks: parseTasks(raw.tasks),
    ...(asString(raw.parentPlanId) ? { parentPlanId: asString(raw.parentPlanId)! } : {}),
    ...(asString(raw.feedback) ? { feedback: asString(raw.feedback)! } : {}),
    ...(launch ? { launch } : {}),
    ...(snapshotRevision !== null && snapshotRequestId
      ? { approvedSnapshot: { revision: snapshotRevision, requestId: snapshotRequestId } }
      : {}),
    updatedAt: asNumber(raw.updatedAt) ?? 0,
  } satisfies TeamPlanView;
}
