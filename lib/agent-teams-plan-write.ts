/**
 * B3 计划卡——**磁盘写入（服务端专用）**。
 *
 * 用户在计划卡里改成员模型 / agent 预设 / 任务负责人后，这里把改动写回
 * `~/.pi/agent/teams/<dir>/plan.json`。与 `lib/agent-teams-plan-store.ts`（只读）分开：
 * 读路径被 GET 路由与无人值守扫描广泛使用，不该把写锁拖进来。
 *
 * 为什么必须由桌面写、而不是投递给 lead：编辑是幂等的表单保存，让 lead 转述会引入
 * 一个模型回合的延迟与不确定性（它可能顺手改别的字段）。pi-team 自己的 `team_plan
 * update` 是给模型用的，语义等价（`replaceTeamPlan(..., { preserveReview: true })`），
 * 这里复刻同一口径。
 *
 * 并发与校验（对齐 pi-team teamPlanStore 的 `mutateTeamPlan`）：
 * - `plan.json.lock` 文件锁串行同一团队的写者；
 * - `expectedRevision` 乐观并发：不匹配即 409（用户看到的提示是「计划已变更」）；
 * - 图校验（成员名合法、id/名字唯一、owner 必须存在、依赖无环）在写前做，
 *   校验失败**不落盘**；
 * - 只允许编辑 `draft` / `review_pending`；保存后**保持原状态**（评审中保存不该把
 *   计划打回草稿，否则用户又要重新提交一次）。
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as lockfile from "proper-lockfile";
import { teamDirFor } from "./agent-teams-swimlane-store";
import { isValidTeamMemberName, type TeamPlanView } from "./agent-teams-plan";

/** Windows rename 瞬时错误的退避上限（与 swimlane-store 的 config 写同口径）。 */
const RENAME_RETRY_MAX_ATTEMPTS = 23;
const PLAN_LOCK_RETRIES = { retries: 10, minTimeout: 5, maxTimeout: 100 } as const;

export class TeamPlanWriteError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "TeamPlanWriteError";
  }
}
/** 409：计划已被别人改过，调用方应重新读取。 */
export const planChangedError = (): TeamPlanWriteError =>
  new TeamPlanWriteError("plan changed; refresh before continuing", 409);
/** 400：请求体本身不合法。 */
export const planInvalidError = (message: string): TeamPlanWriteError =>
  new TeamPlanWriteError(message, 400);

export interface PlanMemberEdit {
  id: string;
  /** 只换 agent 预设时省略。 */
  agentType?: string;
  /** 只换模型时省略；给了就必须两个字段齐全。 */
  runtime?: { providerId: string; modelId: string; effortLevel?: string };
}

export interface PlanTaskEdit {
  id: string;
  /** 空串表示「取消分配」（与界面下拉的「未分配」一致）。 */
  ownerId?: string;
}

export interface PlanPatch {
  planId: string;
  sessionId: string;
  incarnationId: string;
  expectedRevision: number;
  members?: PlanMemberEdit[];
  tasks?: PlanTaskEdit[];
}

/**
 * 写回计划。返回**新的** `TeamPlanView`（revision 已 +1，状态保持）。
 *
 * 改动只落在请求列出的字段上：`members[]` 只覆盖 `agentType` / `runtime`，其余（prompt、
 * reason、difficulty、agentSnapshot…）逐字保留；`tasks[]` 只覆盖 `ownerId`。这样并发
 * 编辑（另一个窗口、lead 自己）不会因为界面传来的残片丢掉字段。
 */
export async function applyTeamPlanEdits(teamName: string, patch: PlanPatch): Promise<TeamPlanView> {
  const dir = teamDirFor(teamName);
  const target = join(dir, "plan.json");
  const release = await lockfile.lock(target, {
    lockfilePath: `${target}.lock`,
    realpath: false,
    retries: { ...PLAN_LOCK_RETRIES },
  });
  try {
    const plan = readPlanSync(dir);
    if (!plan) throw new TeamPlanWriteError(`团队「${teamName}」尚无计划`, 404);
    // 身份四字段必须与磁盘一致（对齐 pi-team requireCurrent）。
    if (
      plan.planId !== patch.planId
      || plan.sessionId !== patch.sessionId
      || plan.incarnationId !== patch.incarnationId
    ) {
      throw planChangedError();
    }
    if (plan.revision !== patch.expectedRevision) throw planChangedError();
    if (plan.state !== "draft" && plan.state !== "review_pending") {
      throw new TeamPlanWriteError("只有草稿或待确认的计划可以编辑", 409);
    }

    const next = applyEdits(structuredClone(plan), patch);
    validatePlanGraph(next);
    next.revision = plan.revision + 1;
    next.updatedAt = Date.now();
    await writePlanWithRetry(dir, next);
    return next as unknown as TeamPlanView;
  } finally {
    await release().catch(() => undefined);
  }
}

/** 纯改动：只覆盖允许的字段，其余原样保留。导出以便单测。 */
export function applyEdits<T extends Record<string, unknown>>(plan: T, patch: PlanPatch): T {
  const next = plan;
  if (patch.members?.length) {
    const members = Array.isArray(next.members) ? (next.members as Record<string, unknown>[]) : [];
    const byId = new Map(members.map((member) => [member.id, member]));
    for (const edit of patch.members) {
      const member = byId.get(edit.id);
      if (!member) continue; // 成员已被删掉：忽略这条编辑，不让整次保存失败
      if (typeof edit.agentType === "string" && edit.agentType.trim()) {
        member.agentType = edit.agentType.trim();
      }
      if (edit.runtime) {
        member.runtime = {
          ...(typeof member.runtime === "object" && member.runtime ? member.runtime : {}),
          providerId: edit.runtime.providerId,
          modelId: edit.runtime.modelId,
          ...(edit.runtime.effortLevel ? { effortLevel: edit.runtime.effortLevel } : {}),
        };
        if (!edit.runtime.effortLevel) delete (member.runtime as Record<string, unknown>).effortLevel;
        // 用户亲自改的模型：与 cc-haha 的 runtimeSource 同口径，防止后续建议覆盖。
        member.runtimeSource = "human";
      }
    }
  }
  if (patch.tasks?.length) {
    const tasks = Array.isArray(next.tasks) ? (next.tasks as Record<string, unknown>[]) : [];
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const edit of patch.tasks) {
      const task = byId.get(edit.id);
      if (!task) continue;
      if (edit.ownerId === "") delete task.ownerId;
      else if (typeof edit.ownerId === "string" && edit.ownerId) task.ownerId = edit.ownerId;
    }
  }
  return next;
}

/**
 * 图校验（对齐 pi-team `validateTeamPlanGraph` 的非 runnable 档）：
 * 成员名合法、id / 名字 / 任务 id 唯一、owner 存在、依赖无环。**不会**要求每个任务都有
 * owner——那是提交审批（submit）时的要求，编辑中途允许留空。
 */
export function validatePlanGraph(plan: Record<string, unknown>): void {
  const members = Array.isArray(plan.members) ? (plan.members as Record<string, unknown>[]) : [];
  const tasks = Array.isArray(plan.tasks) ? (plan.tasks as Record<string, unknown>[]) : [];
  for (const member of members) {
    const name = typeof member.name === "string" ? member.name : "";
    if (!isValidTeamMemberName(name)) {
      throw planInvalidError(
        `成员名不合法：${name || "(空)"}。只能使用字母、数字、下划线或连字符，且不能是 team-lead`,
      );
    }
  }
  const ids = new Set(members.map((member) => member.id));
  const names = new Set(members.map((member) => member.name));
  if (ids.size !== members.length || names.size !== members.length) {
    throw planInvalidError("成员名与成员 ID 必须唯一");
  }
  const taskIds = new Set(tasks.map((task) => task.id));
  if (taskIds.size !== tasks.length) throw planInvalidError("任务 ID 必须唯一");
  for (const task of tasks) {
    const ownerId = task.ownerId;
    if (typeof ownerId === "string" && ownerId && !ids.has(ownerId)) {
      throw planInvalidError(`任务「${String(task.id)}」的负责人不存在：${ownerId}`);
    }
  }
  // 环检测：与 pi-team 同一条 DFS。
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<unknown>();
  const visited = new Set<unknown>();
  const visit = (id: unknown): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw planInvalidError("任务依赖存在环");
    const task = taskById.get(id);
    if (!task) throw planInvalidError(`未知依赖：${String(id)}`);
    visiting.add(id);
    const dependencies = Array.isArray(task.dependencies) ? task.dependencies : [];
    for (const dependency of dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

function readPlanSync(dir: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as unknown;
    return typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** 原子写：临时文件 + rename（Windows 瞬时错误有界退避），失败清临时。 */
async function writePlanWithRetry(dir: string, plan: Record<string, unknown>): Promise<void> {
  const target = join(dir, "plan.json");
  const temp = join(dir, `plan.json.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, target);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
        if (attempt >= RENAME_RETRY_MAX_ATTEMPTS || !transient) throw error;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(25 * 2 ** attempt, 500));
        });
      }
    }
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** 读原始 plan.json（测试与诊断用；路由走 readTeamPlanView 的投影版）。 */
export async function readRawPlan(teamName: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(teamDirFor(teamName), "plan.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}