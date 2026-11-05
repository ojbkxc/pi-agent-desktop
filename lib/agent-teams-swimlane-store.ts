/**
 * 泳道快照的磁盘读取（服务端专用）。
 *
 * 从 ~/.pi/agent/teams/<team>/ 读 pi-team 落盘文件并交给 lib/agent-teams-swimlane.ts
 * 的纯投影。**只读**：不改任何团队文件、不碰会话内部状态。
 *
 * 路径与 pi-team 对齐（constants.getTeamsDir / teamHelpers.sanitizeName），但不 import
 * pi-team 包：其 package.json exports 只暴露 `.` / `./compat` / `./policy`，internal
 * 模块不可达；这里按同名规则复刻，逻辑简单且稳定。
 *
 * 客户端组件不要 import 本文件（含 node:fs）；只 import lib/agent-teams-swimlane.ts。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { userHome } from "./user-home";
import {
  projectTeamWorkbench,
  type AcceptedRecordLike,
  type LifecycleEntryLike,
  type MailboxMessageLike,
  type PlanLike,
  type TeamFileLike,
  type TeamWorkbenchSnapshot,
} from "./agent-teams-swimlane";

/**
 * 团队数据根目录：与 pi-team constants.getTeamsDir 一致（PI_TEAM_DIR 覆盖）。
 * home 用 userHome()（PI_AGENT_HOME 覆盖）以避开 Next 打包期对字面 homedir 的静态求值；
 * 未设覆盖时与 pi-team 的 homedir() 结果相同。
 */
export function teamsRootDir(): string {
  return process.env.PI_TEAM_DIR || join(userHome(), ".pi", "agent", "teams");
}

/** 与 pi-team teamHelpers.sanitizeName 一致：非字母数字转 '-' 并小写。 */
export function sanitizeTeamName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
}

export function teamDirFor(teamName: string): string {
  return join(teamsRootDir(), sanitizeTeamName(teamName));
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readLifecycle(teamDir: string): Promise<Record<string, LifecycleEntryLike>> {
  const file = await readJson<{ members?: Record<string, LifecycleEntryLike> }>(join(teamDir, "lifecycle.json"));
  return file?.members ?? {};
}

async function readAccepted(teamDir: string): Promise<AcceptedRecordLike[]> {
  try {
    const raw = await readFile(join(teamDir, "accepted.jsonl"), "utf8");
    const records: AcceptedRecordLike[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as AcceptedRecordLike;
        if (parsed && typeof parsed.member === "string" && typeof parsed.at === "string") records.push(parsed);
      } catch {
        // 撕裂的最后一行：下次追加会另起一行，忽略之。
      }
    }
    return records;
  } catch {
    return [];
  }
}

/** 读取某成员邮箱的 live + history，并把收件人补进 `to`（邮箱是按收件人分目录的）。 */
async function readMemberMessages(teamDir: string, member: string): Promise<MailboxMessageLike[]> {
  const inboxDir = join(teamDir, "inboxes");
  const live = join(inboxDir, `${member}.json`);
  const history = join(inboxDir, `${member}.history.jsonl`);
  const collected: MailboxMessageLike[] = [];

  const liveRaw = await readJson<MailboxMessageLike[]>(live);
  if (Array.isArray(liveRaw)) {
    for (const message of liveRaw) {
      if (message && typeof message.from === "string") collected.push({ ...message, to: member });
    }
  }

  try {
    const raw = await readFile(history, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as MailboxMessageLike;
        if (parsed && typeof parsed.from === "string") collected.push({ ...parsed, to: member });
      } catch {
        // 同上：撕裂行忽略。
      }
    }
  } catch {
    // 无 history 文件。
  }

  return collected;
}

/** 该团队全部成员的邮箱消息（live + history 合并；identity 去重）。 */
async function readAllMessages(teamDir: string, memberNames: readonly string[]): Promise<MailboxMessageLike[]> {
  let inboxFiles: string[] = [];
  try {
    inboxFiles = await readdir(join(teamDir, "inboxes"));
  } catch {
    inboxFiles = [];
  }
  const recipients = new Set<string>(memberNames);
  for (const file of inboxFiles) {
    const match = /^(.*)\.json$/.exec(file);
    if (match) recipients.add(match[1]);
  }

  const all: MailboxMessageLike[] = [];
  for (const recipient of recipients) {
    all.push(...(await readMemberMessages(teamDir, recipient)));
  }

  const seen = new Set<string>();
  const deduped: MailboxMessageLike[] = [];
  for (const message of all) {
    const identity = message.id ? `id:${message.id}` : `${message.from}|${message.timestamp}|${message.text}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    deduped.push(message);
  }
  // history 在 live 之后，时间序不可靠；按 timestamp 稳定排序。
  deduped.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return deduped;
}

/** 读取一个团队的泳道快照；团队不存在（无 config.json）返回 null。 */
export async function readTeamWorkbench(teamName: string): Promise<TeamWorkbenchSnapshot | null> {
  const teamDir = teamDirFor(teamName);
  const team = await readJson<TeamFileLike>(join(teamDir, "config.json"));
  if (!team || !Array.isArray(team.members)) return null;

  const [plan, lifecycle, accepted, messages] = await Promise.all([
    readJson<PlanLike>(join(teamDir, "plan.json")),
    readLifecycle(teamDir),
    readAccepted(teamDir),
    readAllMessages(teamDir, team.members.map((member) => member.name)),
  ]);

  return projectTeamWorkbench({
    teamName,
    team,
    plan,
    lifecycle,
    accepted,
    messages,
    generatedAt: new Date().toISOString(),
  });
}

/** 找到以某 session 为 lead 的团队名（供 /api/teams/session/[id]/workbench）。 */
export async function findTeamByLeadSession(sessionId: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(teamsRootDir());
  } catch {
    return null;
  }
  for (const name of names) {
    const team = await readJson<TeamFileLike>(join(teamDirFor(name), "config.json"));
    if (team?.leadSessionId === sessionId) return name;
  }
  return null;
}

/** 本机团队名册（供 Agents 面板选择）。 */
export async function listTeams(): Promise<Array<{ name: string; description: string; memberCount: number; createdAt: string }>> {
  let names: string[];
  try {
    names = await readdir(teamsRootDir());
  } catch {
    return [];
  }
  const teams = await Promise.all(names.map(async (name) => {
    const team = await readJson<TeamFileLike>(join(teamDirFor(name), "config.json"));
    if (!team) return null;
    return {
      name,
      description: team.description ?? "",
      memberCount: team.members?.length ?? 0,
      createdAt: typeof team.createdAt === "number" ? new Date(team.createdAt).toISOString() : "",
    };
  }));
  return teams.filter((team): team is NonNullable<typeof team> => team !== null);
}
