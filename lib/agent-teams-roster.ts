/**
 * config.json ∪ plan.json 的合并名册（服务端专用，纯 node:fs/promises）。
 *
 * 为什么存在：config.json 只在 `team_create` 时写一次；`team_plan launch` 派发成员只做
 * lifecycle.adopt、**从不写 config.json**（pi-team 上游行为，见
 * docs/agents/agent-teams-upstream-defects.md B2）——于是「只在 plan 里」的成员在
 * stop/reclaim（agent-teams-team-actions）、ended 判定（agent-teams-team-usage）、
 * 全局配额（agent-teams-swimlane-store）三处按 config 遍历时会整层漏掉。工作台投影
 * buildRoster（agent-teams-swimlane.ts:482-487）早已做 config+plan 合并，本模块把同一
 * 口径下沉到磁盘读取层，保证三处与泳道名册一致。
 *
 * 合并裁决（与 buildRoster 逐条对齐）：
 * - 同名成员以 **config 为准**（config 是身份权威）；plan 只补「config 里没有的同名成员」；
 * - plan 独有成员追加在后，agentId 取 plan 成员 id（plan 与 config 是两套 id 命名空间，
 *   无 id 时回退成员名，同 buildRoster）；
 * - config.json 缺失/不可解析 ⇒ null（调用方按「团队不存在/不可读」处理，不静默当空名册）；
 * - plan.json 缺失/损坏 ⇒ 按「无 plan」处理（团队可能在计划功能出现前就存在；pi-team
 *   原子替换期间的短暂解析失败不应让停止/配额整体失败）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** 合并名册的一名成员（与 team-actions / team-usage / swimlane-store 的名册字段同形）。 */
export interface RosterMember {
  agentId: string;
  name: string;
  sessionId?: string;
}

/** plan.json 成员（只取合并需要的字段）。 */
export interface PlanRosterMember {
  /** plan 成员 id（plan 的 id 命名空间）；无 id 时回退成员名。 */
  agentId: string;
  name: string;
}

/**
 * 纯合并：config 名册在前（以 config 为准），plan 独有成员按序追加（按 name 去重，
 * 与 buildRoster 的裁决一致）。导出以便单测与三处调用点复用同一口径。
 */
export function mergeRosterMembers(
  configMembers: readonly RosterMember[],
  planMembers: readonly PlanRosterMember[],
): RosterMember[] {
  const seen = new Set(configMembers.map((member) => member.name));
  const merged = [...configMembers];
  for (const planMember of planMembers) {
    if (!planMember.name || seen.has(planMember.name)) continue;
    seen.add(planMember.name);
    merged.push({ agentId: planMember.agentId, name: planMember.name });
  }
  return merged;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** 读 plan.json 的成员（容错：缺失/损坏/无成员 ⇒ 空表；口径见文件头注释）。 */
export async function readPlanRosterMembers(teamDir: string): Promise<PlanRosterMember[]> {
  const plan = await readJson<{ members?: unknown }>(join(teamDir, "plan.json"));
  const raw = plan?.members;
  if (!Array.isArray(raw)) return [];
  const members: PlanRosterMember[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    if (!name) continue;
    const id = typeof record.id === "string" && record.id ? record.id : name;
    members.push({ agentId: id, name });
  }
  return members;
}

/** 读合并名册（config 名册 + plan 独有成员）。config.json 缺失/损坏 ⇒ null。 */
export async function readMergedRoster(teamDir: string): Promise<RosterMember[] | null> {
  const config = await readJson<{ members?: unknown }>(join(teamDir, "config.json"));
  const raw = config?.members;
  if (!Array.isArray(raw)) return null;
  const members: RosterMember[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const agentId = typeof record.agentId === "string" ? record.agentId : "";
    const name = typeof record.name === "string" ? record.name : "";
    if (!agentId || !name) continue;
    const sessionId = typeof record.sessionId === "string" && record.sessionId ? record.sessionId : undefined;
    members.push(sessionId ? { agentId, name, sessionId } : { agentId, name });
  }
  const planMembers = await readPlanRosterMembers(teamDir);
  return mergeRosterMembers(members, planMembers);
}
