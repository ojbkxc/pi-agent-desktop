import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  initTheme,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "./pi-types";
import { withWindowsBashFallback } from "./windows-bash-fallback";
import {
  subagentNotificationText,
  subagentToolDetails,
  type ResumeSubagentRequest,
  type StartSubagentRequest,
  type SubagentExecution,
  type SubagentExtensionRuntime,
} from "./subagent-extension";
import {
  readSubagentRun,
  resolveSubagentProfile,
  SUBAGENT_META_TYPE,
  SUBAGENT_STATUS_TYPE,
  SUBAGENT_RESULT_TYPE,
  selectSubagentExtensionTools,
  settleOrphanedSubagentStatus,
  subagentExtensionLoaderOptions,
  subagentToolOptions,
  withSubagentExtensionTools,
  type SubagentMetadata,
  type SubagentResultMetadata,
  type SubagentRunInfo,
} from "./subagents";
import type { SessionEntry } from "./types";
import type { DebugParentNotification, DebugSubagentRun } from "./debug-types";
import { buildSubagentPromptPlan } from "./subagent-prompt";
import { createExactSystemPromptExtension } from "./exact-system-prompt";
// v0.8.2 压缩策略：与 lib/rpc-manager.ts 的普通会话/成员恢复路径装配同一套。
import { createCompactionSettingsManager } from "./compaction-policy";
import { createCompactionModelExtension } from "./compaction-extension";
import { appendSubagentInputFiles, loadSubagentInputFiles, subagentInputLimits } from "./subagent-input";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import { createSubagentSkillsBinding } from "./subagent-skills";
import { createSubagentCodemodeExtension, createSubagentMcpExtensions } from "./builtin-extensions";
import { createSubagentMcpPolicyExtension } from "./mcp-read-only-policy";
import { resolveShellTools } from "./powershell-settings";
import { isBuiltInSubagentsEnabled, readSubagentSettings } from "./subagent-settings";
import { additionalForkSkillPaths } from "./fork-skill-paths";
import { SubagentQueue, type EnqueuedSubagent } from "./subagent-queue";
import { createSubagentBuiltinExtensions } from "./builtin-extensions";
import { LEAN_TOOL_NAMES } from "./lean-mode";
import type { McpHost } from "./mcp-host";
import { addWorktree, removeWorktree } from "./worktree";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

/** 子会话的 MCP 宿主：包装器在 prompt 前等它、关闭时释放它。 */
type SubagentMcpHost = Pick<McpHost, "prepareForPrompt" | "dispose">;

interface HostSession {
  readonly inner: AgentSessionLike;
  readonly sessionFile: string;
  readonly cwd: string;
  isAlive(): boolean;
  isRunning(): boolean;
  waitUntilReady(): Promise<void>;
  /**
   * Connect the session's MCP servers before a run prompts the SDK session directly, past the
   * wrapper's `send()`; false when Stop or `signal` ended the wait and the run must not start.
   */
  prepareMcpForRun?(signal: AbortSignal): Promise<boolean>;
}

export interface SubagentRuntimeDependencies {
  getSession(sessionId: string): HostSession | undefined;
  registerSession(
    inner: AgentSessionLike,
    options?: { exactSystemPrompt?: () => string; chatOnly?: boolean; mcpHost?: SubagentMcpHost },
  ): HostSession | void;
  reopenSession(sessionId: string, sessionFile: string): Promise<HostSession>;
  resolveSessionPath(sessionId: string): Promise<string | null>;
  invalidateSessionList(): void;
  isBuiltInSubagentsEnabled?(): boolean;
}

export interface SubagentController {
  readonly extensionRuntime: SubagentExtensionRuntime;
  get(sessionId: string): Promise<SubagentRunInfo | null>;
  steer(sessionId: string, message: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  /** A turn in a child's own chat ended: settles the run a restart cut off, if that is what the file holds. */
  settleDirectTurn(sessionId: string, aborted: boolean): void;
}

type StoredSubagentExecution = {
  run: SubagentRunInfo;
  completion: Promise<SubagentRunInfo>;
  abortRequested: boolean;
/** Set once the turn limit ends the run; later steering is refused instead of starting another turn. */
  turnLimitReached?: boolean;
  /** 「排队中取消」的句柄（parent abort / subagent abort 工具依赖）：queued 态取消入队的执行。 */
  cancelQueued?: () => boolean;
  /** Ends the wait for the child's MCP servers before its prompt (`prepareChildMcp()`). */
  mcpWait?: AbortController;
  /**
   * When this run (or resume) entered the run map, for the debug panel: a resumed run keeps the
   * first run's `createdAt`. Absent on a run stored before a hot reload.
   */
  dispatchedAt?: number;
  /**
   * D3-1：true 表示生命周期代码（排队/执行）仍在管理该条目。execute 与
   * finishQueuedAbort 的兜底 finally 在任何退出路径上都置 false 并删表；get() 把
   * 「active=false 却仍在表里」的条目当僵尸、按孤儿结算——否则
   * get_subagent_result({wait:true}) 会对僵尸 running 条目永远轮询（#D3-1）。
   */
  active: boolean;
};

/** A run's completion `notifyParent()` is delivering; `since` is absent on one added before a hot reload. */
type ParentNotification = Pick<SubagentRunInfo, "sessionId" | "parentSessionId" | "completedAt"> & { since?: number };

declare global {
  var __piSubagentRuns: Map<string, StoredSubagentExecution> | undefined;
  var __piSubagentQueue: SubagentQueue<SubagentRunInfo> | undefined;
  var __piSubagentConsumedResults: Map<string, string> | undefined;
  var __piSubagentParentNotifications: Set<ParentNotification> | undefined;
}
const SUBAGENT_CONTEXT_LIMIT = 50_000;
const PARENT_IDLE_POLL_MS = 200;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const TURN_LIMIT_INSTRUCTION = "You have reached your turn limit. Wrap up immediately and provide your final answer now.";

/**
 * How the last model request ended when `prompt()` resolved anyway: pi records a provider
 * failure, or a request stopped from the child's own chat, on the assistant message.
 */
function lastAssistantStop(sessionManager: { getEntries?: () => unknown }): { aborted?: true; error?: string } | undefined {
  const entries = sessionManager.getEntries?.();
  if (!Array.isArray(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown } };
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    if (entry.message.stopReason === "aborted") return { aborted: true };
    if (entry.message.stopReason !== "error") return undefined;
    return { error: typeof entry.message.errorMessage === "string" && entry.message.errorMessage ? entry.message.errorMessage : "Provider returned an error" };
  }
  return undefined;
}

function turnLimitError(turnLimit: number, undelivered: readonly string[]): string {
  const error = `Subagent reached its turn limit (${turnLimit}) without completing the task.`;
  if (undelivered.length === 0) return error;
  return `${error} These queued messages were not delivered:\n${undelivered.map((text) => `- ${text}`).join("\n")}`;
}

/**
 * A child with `mcp: on` connects its servers before its prompt, as a prompt sent to the wrapper
 * does. The parent's Stop and `abort()` end the wait through `stored.mcpWait`, the child's own
 * Stop through the wrapper; either way the run is aborted before it starts.
 */
async function prepareChildMcp(session: HostSession | void, stored: StoredSubagentExecution): Promise<void> {
  if (!session?.prepareMcpForRun) return;
  const controller = new AbortController();
  stored.mcpWait = controller;
  try {
    if (stored.abortRequested) controller.abort();
    if (await session.prepareMcpForRun(controller.signal)) return;
  } finally {
    stored.mcpWait = undefined;
  }
  stored.abortRequested = true;
  throw new Error("Stopped while connecting MCP servers");
}

function getSubagentRuns(): Map<string, StoredSubagentExecution> {
  if (!globalThis.__piSubagentRuns) globalThis.__piSubagentRuns = new Map();
  return globalThis.__piSubagentRuns;
}

/**
 * Take a run out of the run map unless a newer run of that session took its place; true when it
 * was still there. Runs call it from `finally` too: a throw before the result entry is written (a
 * session file append failing) must not leave it there, where it would read as running and keep
 * `hasUnsettledSubagentRun()` true for its parent until the server restarts.
 */
function dropSubagentRun(sessionId: string, stored: StoredSubagentExecution): boolean {
  const runs = getSubagentRuns();
  if (runs.get(sessionId) !== stored) return false;
  runs.delete(sessionId);
  return true;
}

/**
 * Runs whose completion `notifyParent()` is still delivering: the run has left the
 * run map, but the parent's turn starts only once the parent is ready and idle. An entry leaves
 * as soon as that turn starts, since the parent is running from then on.
 */
function getParentNotifications(): Set<ParentNotification> {
  globalThis.__piSubagentParentNotifications ??= new Set();
  return globalThis.__piSubagentParentNotifications;
}

/**
 * Runs that can still start a turn in their parent: those in the run map, and notifications
 * not yet delivered whose result the parent has not collected with `get_subagent_result`
 * (`deliverParentNotification()` drops a collected one without a turn).
 */
function unsettledSubagentRuns(): ParentNotification[] {
  const consumed = getConsumedSubagentResults();
  return [
    ...[...getSubagentRuns().values()].map((stored) => stored.run),
    ...[...getParentNotifications()].filter((run) => !run.completedAt || consumed.get(run.sessionId) !== run.completedAt),
  ];
}

/**
 * Whether a subagent run under this session, at any depth, is still unsettled: its end can
 * start a turn there (`notifyParent()`, `triggerTurn`). A run counts from dispatch until its
 * result is written (the run map), then until the turn its parent notification triggers starts,
 * or the delivery is dropped or fails. A hidden page keeps the session's event stream while this
 * holds (#1283), and a main session's run that ends meanwhile announces no completion: the
 * turn a report starts decides that (#1434).
 */
export function hasUnsettledSubagentRun(sessionId: string): boolean {
  return subagentFamily(sessionId, unsettledSubagentRuns()).size > 1;
}

/** `sessionId` and every session under it, at any depth, by the rows' direct parents. */
function subagentFamily(sessionId: string, runs: readonly Pick<SubagentRunInfo, "sessionId" | "parentSessionId">[]): Set<string> {
  const family = new Set([sessionId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const run of runs) {
      if (!family.has(run.parentSessionId) || family.has(run.sessionId)) continue;
      family.add(run.sessionId);
      grew = true;
    }
  }
  return family;
}

/**
 * The run map and the parent notifications for the debug panel: every row, or with a session id
 * the rows under it at any depth (the family `hasUnsettledSubagentRun()` walks). States, flags and
 * times only, never a task, a result, an error or a path. It reads the tables as they are: nothing
 * is created, cancelled or aborted.
 */
export function subagentDebugSnapshot(sessionId?: string): { runs: DebugSubagentRun[]; notifications: DebugParentNotification[] } {
  const stored = [...(globalThis.__piSubagentRuns?.values() ?? [])];
  const pending = [...(globalThis.__piSubagentParentNotifications ?? [])];
  const family = sessionId === undefined
    ? undefined
    : subagentFamily(sessionId, [...stored.map((entry) => entry.run), ...pending]);
  const under = (row: Pick<SubagentRunInfo, "parentSessionId">) => !family || family.has(row.parentSessionId);
  return {
    runs: stored.filter((entry) => under(entry.run)).map((entry) => ({
      sessionId: entry.run.sessionId,
      parentSessionId: entry.run.parentSessionId,
      status: typeof entry.run.status === "string" ? entry.run.status : "unknown",
      profile: typeof entry.run.profile === "string" && entry.run.profile ? entry.run.profile : null,
      background: entry.run.runInBackground === true,
      resumed: entry.run.resumed === true,
      dispatchedAt: typeof entry.dispatchedAt === "number" ? entry.dispatchedAt : null,
      abortRequested: entry.abortRequested === true,
      mcpWaiting: Boolean(entry.mcpWait),
    })),
    notifications: pending.filter(under).map((row) => ({
      sessionId: row.sessionId,
      parentSessionId: row.parentSessionId,
      since: typeof row.since === "number" ? row.since : null,
    })),
  };
}

/** Every session `hasUnsettledSubagentRun()` holds for: the parents of the unsettled runs. */
export function getSessionIdsWithUnsettledSubagentRuns(): string[] {
  return [...new Set(unsettledSubagentRuns().map((run) => run.parentSessionId))];
}

function getSubagentQueue(): SubagentQueue<SubagentRunInfo> {
  if (!globalThis.__piSubagentQueue) globalThis.__piSubagentQueue = new SubagentQueue();
  return globalThis.__piSubagentQueue;
}

type SubagentRunIdentity = Pick<SubagentRunInfo, "sessionId" | "completedAt">;

/**
 * Runs whose terminal result the parent already collected with `get_subagent_result`,
 * keyed by subagent session ID and holding the collected run's `completedAt`. `resume` reruns
 * the same session ID, so the mark must name the run: a parent that polls *after* a run's
 * notification was delivered leaves a mark nothing consumes, and a bare session ID would let it
 * swallow the next run's notification (#987). `resume` deliberately does not clear the entry:
 * the parent can collect a run and resume it in the same turn while that run's notification is
 * still held, and the mark must keep suppressing it. A foreground run whose Agent wait expired
 * also notifies; collecting any terminal run can suppress its report. Each session holds at most
 * one entry.
 */
function getConsumedSubagentResults(): Map<string, string> {
  // A hot reload can leave the pre-#987 Set on globalThis; replace it rather than call Map methods on it.
  if (!(globalThis.__piSubagentConsumedResults instanceof Map)) globalThis.__piSubagentConsumedResults = new Map();
  return globalThis.__piSubagentConsumedResults;
}

function markResultConsumed(run: SubagentRunIdentity): void {
  // A terminal run without `completedAt` (interrupted) never notifies, so there is nothing to drop.
  if (!run.completedAt) return;
  getConsumedSubagentResults().set(run.sessionId, run.completedAt);
}

/** Take the mark only when it names this very run; a mark left by an earlier run is ignored. */
function takeResultConsumed(run: SubagentRunIdentity): boolean {
  const consumed = getConsumedSubagentResults();
  if (!run.completedAt || consumed.get(run.sessionId) !== run.completedAt) return false;
  consumed.delete(run.sessionId);
  return true;
}

/**
 * A run lives in `getSubagentRuns()` from dispatch until its result entry is written, so a
 * persisted `running` / `queued` status reaching `get()` without that entry (and without a running
 * wrapper) was left by a process that stopped mid-run and will never be finished. Report it as
 * `interrupted` so `get_subagent_result({ wait: true })` returns instead of polling forever, and
 * `resume` can pick the session up again.
 */
function settleOrphanedRun(run: SubagentRunInfo): SubagentRunInfo {
  return { ...run, status: settleOrphanedSubagentStatus(run.status) };
}

/** The status of a run this process still holds, so a listing does not have to guess from its file. */
export function getLiveSubagentStatus(sessionId: string): SubagentRunInfo["status"] | undefined {
  return getSubagentRuns().get(sessionId)?.run.status;
}

function findSubagentModel(runtime: ModelRuntime, reference: string) {
  const slash = reference.indexOf("/");
  if (slash > 0) return runtime.getModel(reference.slice(0, slash), reference.slice(slash + 1));
  const matches = runtime.getModels().filter((model) => model.id === reference);
  if (matches.length > 1) throw new Error(`Subagent model is ambiguous; use provider/modelId: ${reference}`);
  return matches[0];
}

/**
 * Reads a model reference as pi's `--model` does: `provider/modelId` or a bare id, optionally
 * followed by `:<thinking level>`. The whole reference is tried first, so an id that itself
 * contains a colon (`qwen3:8b`) still matches; a suffix that is no thinking level never matches.
 */
function parseSubagentModel(runtime: ModelRuntime, value: string | undefined) {
  if (!value?.trim()) return undefined;
  const requested = value.trim();
  const exact = findSubagentModel(runtime, requested);
  if (exact) return { model: exact };
  const colon = requested.lastIndexOf(":");
  const level = requested.slice(colon + 1) as ThinkingLevel;
  if (colon > 0 && THINKING_LEVELS.has(level)) {
    const model = findSubagentModel(runtime, requested.slice(0, colon));
    if (model) return { model, thinkingLevel: level };
  }
  throw new Error(`Subagent model not found: ${requested}`);
}

/**
 * The model the child is expected to run (the call's, else the profile's, else the parent's),
 * looked up early to size `input_files` before a worktree or child session exists (#1199). It
 * never throws: the child's model is resolved for real, and a bad reference refused, only after
 * the child's services have refreshed the shared runtime from models.json and registered its
 * extensions' providers. A reference this lookup misses leaves the files the flat limit.
 */
function expectedSubagentModel(
  runtime: ModelRuntime,
  callModel: string | undefined,
  profileModel: string | undefined,
  parentModel: AgentSessionLike["model"],
) {
  try {
    const reference = callModel?.trim() || profileModel?.trim();
    return reference ? parseSubagentModel(runtime, reference)?.model : parentModel;
  } catch {
    return undefined;
  }
}

function parentContextText(parent: HostSession): string {
  const messages = parent.inner.sessionManager.buildSessionContext().messages;
  const serialized = JSON.stringify(messages);
  if (serialized.length <= SUBAGENT_CONTEXT_LIMIT) return serialized;
  return `${serialized.slice(0, SUBAGENT_CONTEXT_LIMIT)}\n[Parent context truncated]`;
}

/**
 * pi creates a session file only once the session holds a user or assistant message, so a run
 * that ended before its prompt reached the model (stopped while queued or connecting MCP servers,
 * a provider without credentials) kept its metadata and result in memory only. Once the idle
 * child's wrapper was released, `get_subagent_result` and `resume` answered `Subagent not found`
 * for an id the parent had been given, and the session left the sidebar. Write the file when the
 * child is dispatched; `setSessionFile()` reloads it, so pi appends every later entry to it.
 */
function persistChildSession(sessionManager: SessionManager): void {
  const sessionFile = sessionManager.getSessionFile();
  const header = sessionManager.getHeader();
  if (!sessionFile || !header || existsSync(sessionFile)) return;
  const lines = [header, ...sessionManager.getEntries()].map((entry) => JSON.stringify(entry));
  writeFileSync(sessionFile, `${lines.join("\n")}\n`, { flag: "wx" });
  sessionManager.setSessionFile(sessionFile);
}

async function cleanupWorktree(
  parentCwd: string,
  worktree: { path: string; branch: string } | undefined,
): Promise<string | undefined> {
  if (!worktree) return undefined;
  try {
    await removeWorktree(parentCwd, worktree.path);
    return undefined;
  } catch (error) {
    return `Worktree retained at ${worktree.path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Writes a settled run's result entry, which `readSubagentRun()` reads back, and returns the run as
 * recorded. An isolated run's entry keeps whether its worktree path still exists now, which decides
 * what the parent is told about it, live and read back alike (#1202): a checkout removed during
 * the run is gone though git's removal then failed, and a resumed run removes nothing.
 */
function recordResult(sessionManager: SessionManager, run: SubagentRunInfo): SubagentRunInfo {
  const recorded = run.worktreePath ? { ...run, worktreeExists: existsSync(run.worktreePath) } : run;
  const entry: SubagentResultMetadata = {
    version: 1,
    status: recorded.status as SubagentResultMetadata["status"],
    completedAt: recorded.completedAt!,
    ...(recorded.result ? { result: recorded.result } : {}),
    ...(recorded.error ? { error: recorded.error } : {}),
    ...(recorded.worktreeCleanupError ? { worktreeCleanupError: recorded.worktreeCleanupError } : {}),
    ...(recorded.worktreeExists !== undefined ? { worktreeExists: recorded.worktreeExists } : {}),
  };
  sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, entry);
  return recorded;
}

export function createSubagentController(
  dependencies: SubagentRuntimeDependencies,
): SubagentController {
  async function start(request: StartSubagentRequest): Promise<SubagentExecution> {
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    const parent = dependencies.getSession(parentSessionId);
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    if (!parent.sessionFile) throw new Error("Parent session must be persisted before starting a subagent");

    // 团队成员身份（设计文档 §8.4）：成员名与团队名作为参数流进扩展工厂，pi-team 在
    // 其工厂**同步函数体内**设置/还原 env 并在构造期捕获（见
    // lib/pi-extension-builtins.ts 的 teamBuiltin）。不再在 start() 顶部开跨 await 的
    // 进程 env 窗口——那个窗口横跨 addWorktree（最长 5 分钟）与 runtime 构建，并发
    // 派发时互相串号，还可能把成员身份永久写回进程 env。

    let isolatedWorktree: { path: string; branch: string } | undefined;
    try {
      const resolvedProfile = resolveSubagentProfile(parent.cwd, request.profile);
      if (!resolvedProfile) throw new Error(`Unknown or disabled subagent profile: ${request.profile}`);
      // 请求可以覆盖资源策略：团队派发的成员用它把权限开到最大（技能与扩展都加载）。
      // 覆写发生在**解析处**，下游一律照旧读 `profile.*` —— 这样「策略由 profile 流向
      // 会话」这条链路（以及钉住它的哨兵）保持成立，而 preference 只是被提前合进来。
      // 极简档（request.lean）是整体收窄，优先级高于 loadSkills/loadExtensions。
      const profile = request.lean
        ? {
            ...resolvedProfile,
            tools: [...LEAN_TOOL_NAMES],
            loadSkills: false,
            loadExtensions: false,
          }
        : (request.loadSkills === undefined && request.loadExtensions === undefined)
          ? resolvedProfile
          : {
              ...resolvedProfile,
              ...(request.loadSkills !== undefined ? { loadSkills: request.loadSkills } : {}),
              ...(request.loadExtensions !== undefined ? { loadExtensions: request.loadExtensions } : {}),
            };

      const runInBackground = request.runInBackground ?? profile.runInBackground;
      const isolation = profile.isolation === "off" ? undefined : request.isolation ?? profile.isolation;
      const parentModelRuntime = (parent.inner as unknown as { modelRuntime: ModelRuntime }).modelRuntime;
      // Sized by the window of the model expected to read the copy, and refused before a worktree
      // or child session exists.
      const inputFiles = loadSubagentInputFiles(parent.cwd, request.inputFiles ?? [], subagentInputLimits(
        expectedSubagentModel(parentModelRuntime, request.model, profile.model, parent.inner.model),
      ));
      if (isolation === "worktree") {
        isolatedWorktree = await addWorktree(parent.cwd, `pi-web-agent-${randomUUID()}`);
      }
      const childCwd = isolatedWorktree?.path ?? parent.cwd;
      // A caller (e.g. the ralph loop's inheritContext:false) overrides the profile default;
      // the merge had collapsed this to profile-only, silently re-enabling inheritance.
      const inheritContext = request.inheritContext ?? profile.inheritContext;
      // `parseProfileFile` already floors a positive profile `max_turns`, so it is an integer or absent.
      const turnLimit = profile.maxTurns;

      const agentDir = getAgentDir();
      const inheritedParentContext = inheritContext
        ? `The following is the active conversation context from the parent session. Use it only as background for the delegated task:\n${parentContextText(parent)}`
        : undefined;
      const promptPlan = buildSubagentPromptPlan({
        profileSystemPrompt: profile.systemPrompt,
        tools: profile.tools,
        loadSkills: profile.loadSkills,
        loadExtensions: profile.loadExtensions,
        promptMode: profile.promptMode,
        task: appendSubagentInputFiles(request.task, inputFiles),
        inheritedParentContext,
        teamIdentity: { agentName: request.agentName, teamName: request.teamName },
      });
      const parentCodemodeEnabled = parent.inner.getActiveToolNames().includes("codemode");
      const wantsCodemode = profile.codemode === "on"
        || (profile.codemode === "inherit" && parentCodemodeEnabled);
      if (promptPlan.chatOnly && profile.codemode === "on") {
        throw new Error("Code mode cannot be enabled for a chat-only subagent profile");
      }
      // A chat-only profile remains chat-only when inheritance is selected. An explicit `on`
      // is rejected above so it cannot silently grant a script capability to tools:none.
      const codemodeEnabled = !promptPlan.chatOnly && wantsCodemode;
      if (promptPlan.chatOnly && profile.mcp === "on") {
        throw new Error("MCP cannot be enabled for a chat-only subagent profile");
      }
      const mcpEnabled = profile.mcp === "on";
      const chatOnly = promptPlan.chatOnly;
      const { appendSystemPrompt, delegatedTask } = promptPlan;
      const skillsBinding = createSubagentSkillsBinding({
        loadSkills: profile.loadSkills,
        skills: profile.skills,
        exactSystemPrompt: promptPlan.exactSystemPrompt,
      });
      const codemodeExtension = codemodeEnabled
        ? await createSubagentCodemodeExtension({
            agentDir,
            cwd: childCwd,
            projectTrusted: () => settingsManager.isProjectTrusted(),
          })
        : undefined;
      // The policy reads the child's tools once they are resolved below.
      const mcpScope: { tools: readonly string[]; allExtensionTools?: boolean } = { tools: [] };
      const mcp = mcpEnabled
        ? await createSubagentMcpExtensions({
            agentDir,
            cwd: childCwd,
            projectTrusted: () => settingsManager.isProjectTrusted(),
            codemode: codemodeEnabled,
          })
        : undefined;
      const extensionFactories = [
        ...(codemodeExtension ? [codemodeExtension] : []),
        ...(mcp ? [...mcp.extensions, createSubagentMcpPolicyExtension(() => mcpScope)] : []),
        ...(skillsBinding.loaderOptions.extensionFactories ?? []),
      ];
      if (!chatOnly) initTheme();
      // 团队成员拿到的内置扩展（codemode / tool-search / mcp / pi-lsp / pi-team）。
      // 与 rpc-manager 的恢复路径必须装配同一批，否则「跑一次→重开」行为不一致。
      // 成员身份经 teamIdentity 参数进工厂闭包。
      const memberBuiltins = await createSubagentBuiltinExtensions({
        agentDir,
        lean: request.lean === true,
        ...((request.agentName || request.teamName)
          ? { teamIdentity: { agentName: request.agentName, teamName: request.teamName } }
          : {}),
      });
      // v0.8.2 压缩策略：极简档按「不加载扩展」整体收窄，chat-only 子会话与 rpc-manager
      // 的 chatOnly 分支一致地不装配；其余成员（含 loadExtensions=false 的普通子代理）都装配。
      // 与恢复路径 lib/rpc-manager.ts 的 compactionEnabled 必须同规则。
      const compactionEnabled = request.lean !== true && !chatOnly;
      // The child runs on the parent session's trust, as pi's `--approve` / `--no-approve`
      // decide a run: read once here, never written. Created trusted by default, a child
      // that loads no resources read the project settings of a folder never trusted; and
      // an isolated run's throwaway worktree has no decision of its own to find.
      const projectTrusted = getProjectTrustStatus(parent.cwd, agentDir).trusted;
      const baseSettingsManager = SettingsManager.create(childCwd, agentDir, { projectTrusted });
      // 成员会话与普通会话同规则（见 lib/rpc-manager.ts）：Windows 上 Git 不在
      // %ProgramFiles% 时补 shellPath，否则成员的 bash 工具同样报 "No bash shell found"。
      const settingsManager = compactionEnabled
        ? createCompactionSettingsManager(withWindowsBashFallback(baseSettingsManager))
        : withWindowsBashFallback(baseSettingsManager);
      const services = await createAgentSessionServices({
        cwd: childCwd,
        agentDir,
        modelRuntime: parentModelRuntime,
        settingsManager,
        resourceLoaderOptions: {
          noSkills: !profile.loadSkills,
          // 团队成员与普通会话加载同一批技能：额外接上 cc-haha 的用户级技能根。技能被 profile
          // 关掉时（含极简档 lean）不传，避免绕过 noSkills 反而多加载。
          additionalSkillPaths: additionalForkSkillPaths(profile.loadSkills),
          ...subagentExtensionLoaderOptions({ ...profile, mcp: mcpEnabled }),
          ...skillsBinding.loaderOptions,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          ...(chatOnly || promptPlan.exactSystemPrompt !== undefined
            ? {
                systemPrompt: " ",
                systemPromptOverride: () => undefined,
              }
            : {}),
          appendSystemPrompt,
...(extensionFactories.length > 0
            || memberBuiltins.extensions.length > 0
            || promptPlan.exactSystemPrompt !== undefined
            || compactionEnabled
            ? {
                extensionFactories: [
                  // 成员内置扩展（codemode / tool-search / mcp / pi-lsp / pi-team）。
                  ...memberBuiltins.extensions,
                  // The exact prompt is sent through before_agent_start; see lib/exact-system-prompt.ts.
                  ...(promptPlan.exactSystemPrompt !== undefined
                    ? [createExactSystemPromptExtension(() => promptPlan.exactSystemPrompt)]
                    : []),
                  // v0.8.2：只路由本次摘要请求；全部候选失败返回 undefined 交回 SDK。
                  ...(compactionEnabled ? [createCompactionModelExtension()] : []),
                  // upstream：codemode / mcp / 技能投影的扩展工厂。
                  ...extensionFactories,
                ],
              }
            : {}),
        },
        ...((profile.loadExtensions || profile.loadSkills || codemodeEnabled || mcpEnabled)
          ? { resourceLoaderReloadOptions: projectTrustReloadOptions(childCwd, agentDir) }
          : {}),
      });

      if (codemodeEnabled && !services.resourceLoader.getExtensions().extensions.some((extension) => extension.tools.has("codemode"))) {
        throw new Error("Code mode is unavailable: builtin:codemode was not registered");
      }

      // `ext:` selectors that `disallowed_tools` cancels out leave an empty list, which admits none.
      const allExtensionTools = profile.loadExtensions && profile.extensionTools === undefined;
      // 内置扩展的工具名不随 profile.loadExtensions 开关（那是给文件系统扩展用的），
      // 否则 MCP / codemode 注册了也不会被激活 —— 子会话的工具白名单是静态算出来的。
      const extensionToolNames = [
        ...memberBuiltins.toolNames,
        ...(profile.loadExtensions
          ? profile.extensionTools !== undefined
            ? selectSubagentExtensionTools(
              services.resourceLoader.getExtensions().extensions,
              profile.extensionTools,
              profile.disallowedExtensionTools,
            )
            : services.resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()])
          : []),
      ];
      const activeTools = resolveShellTools(
        withSubagentExtensionTools(profile.tools, extensionToolNames),
        settingsManager.getDefaultTools(),
      );
      if (codemodeEnabled && !activeTools.includes("codemode")) activeTools.push("codemode");
      mcpScope.tools = activeTools;
      mcpScope.allExtensionTools = allExtensionTools;

      const sessionManager = isolatedWorktree
        ? SessionManager.create(childCwd, undefined, { parentSession: parent.sessionFile })
        : SessionManager.create(parent.cwd, undefined, { parentSession: parent.sessionFile });
      const createdAt = new Date().toISOString();
      const metadata: SubagentMetadata = {
        version: 1,
        parentSessionId,
        parentSessionPath: parent.sessionFile,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: request.description.trim() || profile.displayName,
        task: request.task,
        runInBackground,
        createdAt,
        resourceSnapshot: {
          version: 1,
          appendSystemPrompt: [...appendSystemPrompt],
          tools: [...activeTools],
          ...(codemodeEnabled ? { codemode: true as const } : {}),
          ...(mcpEnabled ? { mcp: true as const } : {}),
          loadSkills: profile.loadSkills,
...(profile.skills !== undefined ? { skills: [...profile.skills] } : {}),
          loadExtensions: profile.loadExtensions,
          // v0.8.2：恢复路径据此与新建路径同规则决定是否装配压缩策略（lean 的工具集
          // 与普通成员相同，只有这个标志能区分）。
          lean: request.lean === true,
          ...(allExtensionTools ? { allExtensionTools: true } : {}),
          ...(profile.extensions !== undefined ? { extensions: [...profile.extensions] } : {}),
          ...(promptPlan.exactSystemPrompt !== undefined ? { exactSystemPrompt: promptPlan.exactSystemPrompt } : {}),
        },
        ...(isolatedWorktree ? { worktreePath: isolatedWorktree.path, worktreeBranch: isolatedWorktree.branch } : {}),
      };
      sessionManager.appendCustomEntry(SUBAGENT_META_TYPE, metadata);
      sessionManager.appendSessionInfo(metadata.description);

      // A `:level` suffix travels with its model. As with pi's `--thinking` over `--model x:level`,
      // the profile's own `thinking` beats a suffix on the profile's model, while a call naming
      // a model with a suffix chose both for this run.
      const callModel = parseSubagentModel(parentModelRuntime, request.model);
      const profileModel = callModel ? undefined : parseSubagentModel(parentModelRuntime, profile.model);
      const thinking = callModel?.thinkingLevel
        ?? profile.thinking
        ?? profileModel?.thinkingLevel
        ?? parent.inner.agent.state?.thinkingLevel;
      if (thinking && !THINKING_LEVELS.has(thinking as ThinkingLevel)) {
        throw new Error(`Invalid subagent thinking level: ${thinking}`);
      }
      const parentModel = parent.inner.model as ReturnType<ModelRuntime["getModel"]>;
      const { session: inner } = await createAgentSessionFromServices({
        services,
        sessionManager,
        model: (callModel ?? profileModel)?.model ?? parentModel,
        ...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
        ...subagentToolOptions({ tools: activeTools, allExtensionTools, mcp: mcpEnabled }),
      });
      persistChildSession(sessionManager);
      skillsBinding.setActiveToolsGetter(() => inner.getActiveToolNames());
      const childSession = dependencies.registerSession(inner, {
        ...(skillsBinding.getExactSystemPrompt !== undefined
          ? { exactSystemPrompt: skillsBinding.getExactSystemPrompt }
          : {}),
        chatOnly,
...(memberBuiltins.mcpHost ?? mcp?.mcpHost
          ? { mcpHost: (memberBuiltins.mcpHost ?? mcp?.mcpHost)! }
          : {}),
      });

      const initialRun: SubagentRunInfo = {
        sessionId: inner.sessionId,
        sessionPath: inner.sessionFile ?? sessionManager.getSessionFile() ?? "",
        parentSessionId,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: metadata.description,
        task: request.task,
        runInBackground,
        status: "queued",
        createdAt,
        ...(isolatedWorktree ? { worktreePath: isolatedWorktree.path, worktreeBranch: isolatedWorktree.branch } : {}),
      };

      let resolveCompletion!: (run: SubagentRunInfo) => void;
      const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
      const stored: StoredSubagentExecution = {
        run: initialRun,
        completion,
        abortRequested: false,
        active: true,
        dispatchedAt: Date.now(),
      };
      getSubagentRuns().set(initialRun.sessionId, stored);
      try {
        request.onUpdate?.(initialRun);
        dependencies.invalidateSessionList();
      } catch (error) {
        // D3-1：入表后的同步失败（onUpdate/列表缓存失效）必须删表，否则条目僵尸化。
        getSubagentRuns().delete(initialRun.sessionId);
        throw error;
      }

      const handleParentAbort = () => {
        stored.abortRequested = true;
        if (stored.run.status === "queued") stored.cancelQueued?.();
        else if (stored.mcpWait) stored.mcpWait.abort();
        else void inner.abort();
      };
      if (!runInBackground) {
        if (request.signal?.aborted) handleParentAbort();
        else request.signal?.addEventListener("abort", handleParentAbort, { once: true });
      }

      const runToResult = async (): Promise<SubagentRunInfo> => {
        // Reached only when the abort fires while the run is being queued, before `cancelQueued`
        // is set; a run aborted later in the queue ends in `finishQueuedAbort`.
        if (stored.abortRequested) {
          const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
          const result = recordResult(sessionManager, {
            ...initialRun,
            status: "aborted",
            completedAt: new Date().toISOString(),
            ...(cleanupError ? { worktreeCleanupError: cleanupError } : {}),
          });
          stored.run = result;
          request.onUpdate?.(result);
          getSubagentRuns().delete(initialRun.sessionId);
          dependencies.invalidateSessionList();
          return result;
        }
        stored.run = { ...stored.run, status: "running" };
        sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
        request.onUpdate?.(stored.run);
        dependencies.invalidateSessionList();
        let turnCount = 0;
        let maxTurnsReached = false;
        let undelivered: string[] = [];
        const previousFinishTurn = inner.agent.finishTurn;
        const previousSteeringMode = inner.agent.steeringMode;
        let unsubscribeTools: (() => void) | undefined;
        if (turnLimit) {
          // Finalized events retain the SDK's terminate hint; tool-result messages do not.
          const terminatingTools = new Set<string>();
          unsubscribeTools = inner.subscribe((event) => {
            if (event.type === "tool_execution_end" && event.result?.terminate === true) {
              terminatingTools.add(event.toolCallId);
            }
          });
          inner.agent.finishTurn = async (turn, signal) => {
            const decision = (await previousFinishTurn?.(turn, signal)) ?? undefined;
            const toolsContinue = turn.toolResults.some((message) => !terminatingTools.has(message.toolCallId));
            terminatingTools.clear();
            turnCount += 1;
            if (signal?.aborted || decision?.action === "end" ||
              turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return decision;
            const needsAnotherTurn = toolsContinue || decision?.action === "continue" || inner.agent.hasQueuedMessages();
            if (!needsAnotherTurn || turnCount < turnLimit) return decision;
            if (turnCount >= turnLimit + 1) {
              maxTurnsReached = true;
              stored.turnLimitReached = true;
              // AgentSession starts another run for anything still queued, past an `end`
              // decision, so the limit holds only once the queues are empty.
              const { steering, followUp } = inner.clearQueue();
              undelivered = [...undelivered, ...steering, ...followUp];
              return { action: "end" };
            }
            // The awaited SDK boundary delivers the instruction before the wrap-up request.
            // In one-at-a-time mode a steer queued earlier would take the wrap-up turn and
            // leave the instruction for later, so that turn takes everything queued.
            inner.agent.steeringMode = "all";
            await inner.steer(TURN_LIMIT_INSTRUCTION);
            return decision;
          };
        }
        let result: SubagentRunInfo;
        try {
          await prepareChildMcp(childSession, stored);
          await inner.prompt(delegatedTask, { source: "rpc" });
          const text = inner.getLastAssistantText()?.trim();
          const stop = stored.abortRequested ? undefined : lastAssistantStop(sessionManager);
          const aborted = stored.abortRequested || stop?.aborted === true;
          const errorMessage = aborted ? undefined : stop?.error ??
            (maxTurnsReached && turnLimit ? turnLimitError(turnLimit, undelivered) : undefined);
          result = {
            ...initialRun,
            status: aborted ? "aborted" : errorMessage ? "failed" : "completed",
            completedAt: new Date().toISOString(),
            ...(text ? { result: text } : {}),
            ...(errorMessage ? { error: errorMessage } : {}),
          };
        } catch (error) {
          const text = inner.getLastAssistantText()?.trim();
          const aborted = stored.abortRequested || request.signal?.aborted;
          result = {
            ...initialRun,
            status: aborted ? "aborted" : "failed",
            completedAt: new Date().toISOString(),
            ...(text ? { result: text } : {}),
            ...(!aborted
              ? { error: error instanceof Error ? error.message : String(error) }
              : {}),
          };
        } finally {
          if (turnLimit) {
            inner.agent.finishTurn = previousFinishTurn;
            inner.agent.steeringMode = previousSteeringMode;
          }
          unsubscribeTools?.();
          request.signal?.removeEventListener("abort", handleParentAbort);
        }

        const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
        if (cleanupError) result = { ...result, worktreeCleanupError: cleanupError };
        result = recordResult(sessionManager, result);
        stored.run = result;
        request.onUpdate?.(result);
        getSubagentRuns().delete(initialRun.sessionId);
        dependencies.invalidateSessionList();
        return result;
      };
      const execute = async (): Promise<SubagentRunInfo> => {
        try {
          return await runToResult();
        } finally {
          if (dropSubagentRun(initialRun.sessionId, stored)) dependencies.invalidateSessionList();
        }
      };

      const finishQueuedAbortOnce = async () => {
        if (stored.run.status !== "queued") return;
        try {
          const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString() };
          const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
          const finalResult = recordResult(sessionManager, cleanupError ? { ...result, worktreeCleanupError: cleanupError } : result);
          stored.run = finalResult;
          request.onUpdate?.(finalResult);
          getSubagentRuns().delete(initialRun.sessionId);
          dependencies.invalidateSessionList();
          resolveCompletion(finalResult);
        } finally {
          if (dropSubagentRun(initialRun.sessionId, stored)) dependencies.invalidateSessionList();
        }
      };
      // D3-1：排队取消的兜底 finally 也清 active 标记并删表；正常终态路径内的 delete 与这里幂等。
      const finishQueuedAbort = async (): Promise<void> => {
        try {
          await finishQueuedAbortOnce();
        } finally {
          stored.active = false;
          getSubagentRuns().delete(initialRun.sessionId);
        }
      };
      let queued: EnqueuedSubagent<SubagentRunInfo>;
      try {
        queued = getSubagentQueue().enqueue(
          parentSessionId,
          readSubagentSettings().maxConcurrent,
          execute,
          (state) => {
            if (state === "queued") {
              sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
            }
            request.onUpdate?.({ ...stored.run, status: state });
            stored.run = { ...stored.run, status: state };
            dependencies.invalidateSessionList();
          },
          finishQueuedAbort,
        );
      } catch (error) {
// D3-1：enqueue 先 onState 后 pump，onState 抛错时 execute 尚未运行，删表后原样上抛。
        request.signal?.removeEventListener("abort", handleParentAbort);
        stored.active = false;
        dropSubagentRun(initialRun.sessionId, stored);
        dependencies.invalidateSessionList();
        throw error;
      }
      stored.cancelQueued = queued.cancel;
      if (stored.abortRequested) queued.cancel();
      void queued.promise.then(resolveCompletion, (error) => {
// D3-1：execute/取消的异常退出经 queue reject 到这里；正常终态已在 execute 内删表，此处幂等。
        stored.active = false;
        dropSubagentRun(initialRun.sessionId, stored);
        dependencies.invalidateSessionList();
        resolveCompletion({ ...initialRun, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
      });

      return { run: stored.run, completion: stored.completion };
    } catch (error) {
      if (isolatedWorktree) {
        try { await removeWorktree(parent.cwd, isolatedWorktree.path); } catch { /* preserve setup failure and avoid force deletion */ }
      }
      throw error;
    }
  }

  async function resume(request: ResumeSubagentRequest): Promise<SubagentExecution> {
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    const existing = await get(request.sessionId);
    if (!existing) throw new Error(`Subagent not found: ${request.sessionId}`);
    if (existing.parentSessionId !== parentSessionId) throw new Error("Subagent does not belong to this parent session");
    // pi-team parks a member through `host.stop`, but the desktop run record can
    // stay at active/running when the wrapper was already gone (its `prompt()`
    // never settles). Every later revive would then be refused as "already
    // running". Refuse only when the session is genuinely running now; otherwise
    // settle the stale entry so the revive can proceed.
    const staleRun = getSubagentRuns().get(request.sessionId);
    const wrapperBefore = dependencies.getSession(request.sessionId);
    const genuinelyRunning = Boolean(wrapperBefore?.isAlive() && wrapperBefore.isRunning());
    if ((existing.status === "running" || existing.status === "queued") && genuinelyRunning) {
      throw new Error("Subagent is already running");
    }
    if (staleRun && !genuinelyRunning) {
      staleRun.abortRequested = true;
      staleRun.active = false;
      staleRun.run = settleOrphanedRun(staleRun.run);
      if (getSubagentRuns().get(request.sessionId) === staleRun) {
        getSubagentRuns().delete(request.sessionId);
      }
    }
    const parent = dependencies.getSession(parentSessionId);
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    const sessionPath = existing.sessionPath || await dependencies.resolveSessionPath(request.sessionId);
    if (!sessionPath) throw new Error(`Subagent session file not found: ${request.sessionId}`);
    let wrapper = dependencies.getSession(request.sessionId);
    if (!wrapper?.isAlive()) wrapper = await dependencies.reopenSession(request.sessionId, sessionPath);
    if (!wrapper.isAlive()) throw new Error("Subagent session is no longer available");
    if (wrapper.isRunning()) throw new Error("Subagent is already running");
    // The run prompts the SDK session directly, past the wrapper's `send()`, so refuse here as
    // `send()` does: an isolated child's worktree is removed when its run ends, and a run in the
    // missing folder would only let the model's tools fail (and `write` recreate it outside git).
    // The error reaches the model, so it also says what to do instead.
    if (!existsSync(wrapper.cwd)) throw new Error(`Directory does not exist: ${wrapper.cwd}. Start a new subagent instead.`);

    const runInBackground = request.runInBackground ?? existing.runInBackground;
    const initialRun: SubagentRunInfo = {
      ...existing,
      parentToolCallId: request.parentToolCallId,
      task: request.task,
      description: request.description.trim() || existing.description,
      runInBackground,
      status: "queued",
      completedAt: undefined,
      result: undefined,
      error: undefined,
      // Resume removes no worktree: this run's result says only whether it is still there.
      worktreeCleanupError: undefined,
      worktreeExists: undefined,
      resumed: true,
    };
    const manager = wrapper.inner.sessionManager;
    let resolveCompletion!: (run: SubagentRunInfo) => void;
    const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
    const stored: StoredSubagentExecution = { run: initialRun, completion, abortRequested: false, active: true, dispatchedAt: Date.now() };
    getSubagentRuns().set(request.sessionId, stored);
    // Only drop our own entry: a stale previous run's `finally` must not delete a
    // newer execution that a revive installed for the same session id.
    const forgetStored = (): void => {
      const registry = getSubagentRuns();
      if (registry.get(request.sessionId) === stored) registry.delete(request.sessionId);
    };
    try {
      request.onUpdate?.(initialRun);
      dependencies.invalidateSessionList();
    } catch (error) {
      // D3-1：入表后的同步失败（onUpdate/列表缓存失效）必须删表，否则条目僵尸化。
      forgetStored();
      throw error;
    }
    const handleParentAbort = () => {
      stored.abortRequested = true;
      if (stored.run.status === "queued") stored.cancelQueued?.();
      else if (stored.mcpWait) stored.mcpWait.abort();
      else void wrapper!.inner.abort();
    };
    if (!runInBackground) {
      if (request.signal?.aborted) handleParentAbort();
      else request.signal?.addEventListener("abort", handleParentAbort, { once: true });
    }

    const runToResult = async (): Promise<SubagentRunInfo> => {
      if (stored.abortRequested) {
        const result = recordResult(manager, { ...initialRun, status: "aborted", completedAt: new Date().toISOString() });
        stored.run = result;
        forgetStored();
        resolveCompletion(result);
        return result;
      }
      stored.run = { ...stored.run, status: "running" };
      manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
      request.onUpdate?.(stored.run);
      let result: SubagentRunInfo;
      try {
        await prepareChildMcp(wrapper, stored);
        await wrapper!.inner.prompt(request.task, { source: "rpc" });
        const text = wrapper!.inner.getLastAssistantText()?.trim();
        const stop = stored.abortRequested ? undefined : lastAssistantStop(manager);
        const aborted = stored.abortRequested || stop?.aborted === true;
        const providerError = aborted ? undefined : stop?.error;
        result = {
          ...initialRun,
          status: aborted ? "aborted" : providerError ? "failed" : "completed",
          completedAt: new Date().toISOString(),
          ...(text ? { result: text } : {}),
          ...(providerError ? { error: providerError } : {}),
        };
      } catch (error) {
        result = {
          ...initialRun,
          status: stored.abortRequested || request.signal?.aborted ? "aborted" : "failed",
          completedAt: new Date().toISOString(),
          ...(!stored.abortRequested && !request.signal?.aborted ? { error: error instanceof Error ? error.message : String(error) } : {}),
        };
      } finally {
        request.signal?.removeEventListener("abort", handleParentAbort);
      }
      result = recordResult(manager, result);
      stored.run = result;
      request.onUpdate?.(result);
      forgetStored();
      dependencies.invalidateSessionList();
      return result;
    };
    const execute = async (): Promise<SubagentRunInfo> => {
      try {
        return await runToResult();
      } finally {
        stored.active = false;
        if (dropSubagentRun(request.sessionId, stored)) dependencies.invalidateSessionList();
      }
    };
    const finishQueuedAbort = () => {
      if (stored.run.status !== "queued") return;
      try {
        const result = recordResult(manager, { ...initialRun, status: "aborted", completedAt: new Date().toISOString() });
        stored.run = result;
        request.onUpdate?.(result);
        getSubagentRuns().delete(request.sessionId);
        dependencies.invalidateSessionList();
        resolveCompletion(result);
      } finally {
        stored.active = false;
        if (dropSubagentRun(request.sessionId, stored)) dependencies.invalidateSessionList();
      }
    };
    let queued: EnqueuedSubagent<SubagentRunInfo>;
    try {
      queued = getSubagentQueue().enqueue(parentSessionId, readSubagentSettings().maxConcurrent, execute, (state) => {
        if (state === "queued") manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
        stored.run = { ...stored.run, status: state };
        request.onUpdate?.(stored.run);
        dependencies.invalidateSessionList();
      }, finishQueuedAbort);
    } catch (error) {
// D3-1：enqueue 先 onState 后 pump，onState 抛错时 execute 尚未运行，删表后原样上抛。
      request.signal?.removeEventListener("abort", handleParentAbort);
      stored.active = false;
      if (dropSubagentRun(request.sessionId, stored)) dependencies.invalidateSessionList();
      throw error;
    }
    stored.cancelQueued = queued.cancel;
    if (stored.abortRequested) queued.cancel();
    void queued.promise.then(resolveCompletion, (error) => {
      // D3-1：execute/取消的异常退出经 queue reject 到这里；正常终态已在 execute 内删表，此处幂等。
      stored.active = false;
      if (dropSubagentRun(request.sessionId, stored)) dependencies.invalidateSessionList();
      resolveCompletion({ ...initialRun, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
    });
    return { run: stored.run, completion };
  }

  async function get(sessionId: string): Promise<SubagentRunInfo | null> {
    const stored = getSubagentRuns().get(sessionId);
    if (stored) {
      // D3-1：生命周期代码已退出（active=false）却仍在表里 ⇒ 清理被异常路径跳过的僵尸条目。
      // 不结算的话 wait:true 会对它永远轮询；按孤儿结算后 resume 仍可捡起该会话。
      if (!stored.active) return settleOrphanedRun(stored.run);
      return stored.run;
    }
    const wrapper = dependencies.getSession(sessionId);
    if (wrapper?.isAlive()) {
      const run = readSubagentRun(
        wrapper.inner.sessionManager.getEntries() as unknown as SessionEntry[],
        sessionId,
        wrapper.sessionFile,
      );
      if (run && wrapper.isRunning()) return { ...run, status: "running" };
      if (run) return settleOrphanedRun(run);
    }
    const sessionPath = await dependencies.resolveSessionPath(sessionId);
    if (!sessionPath) return null;
    const manager = SessionManager.open(sessionPath);
    const run = readSubagentRun(manager.getEntries() as unknown as SessionEntry[], sessionId, sessionPath);
    return run && settleOrphanedRun(run);
  }

  async function steer(sessionId: string, message: string): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    if (getSubagentRuns().get(sessionId)?.turnLimitReached) throw new Error("Subagent reached its turn limit and is stopping; resume it to continue");
    if (!message.trim()) throw new Error("Steering message is required");
    await wrapper.inner.steer(message.trim());
  }

  async function notifyParent(run: SubagentRunInfo): Promise<void> {
    const pending = { sessionId: run.sessionId, parentSessionId: run.parentSessionId, completedAt: run.completedAt, since: Date.now() };
    const notifications = getParentNotifications();
    notifications.add(pending);
    try {
      await deliverParentNotification(run, () => notifications.delete(pending));
    } finally {
      notifications.delete(pending);
    }
  }

  async function deliverParentNotification(run: SubagentRunInfo, onTurnStarted: () => void): Promise<void> {
    if (takeResultConsumed(run)) return;
    let parent = dependencies.getSession(run.parentSessionId);
    if (!parent?.isAlive()) {
      const sessionFile = await dependencies.resolveSessionPath(run.parentSessionId);
      if (!sessionFile) throw new Error(`Parent session not found: ${run.parentSessionId}`);
      parent = await dependencies.reopenSession(run.parentSessionId, sessionFile);
    }
    await parent.waitUntilReady();
    // The parent may still be inside the `get_subagent_result` call that collects this result,
    // and `deliverAs: "followUp"` would only queue the message until that turn ends anyway.
    // Hold the notification until the parent is idle and re-check the mark, so a result the
    // parent already consumed never triggers a duplicate turn.
    while (parent.isAlive() && parent.isRunning()) {
      if (takeResultConsumed(run)) return;
      await new Promise<void>((resolve) => { setTimeout(resolve, PARENT_IDLE_POLL_MS); });
    }
    if (takeResultConsumed(run)) return;
    if (!parent.isAlive()) throw new Error(`Parent session is no longer available: ${run.parentSessionId}`);
    const delivery = parent.inner.sendCustomMessage({
      customType: "pi-web:subagent-notification",
      content: subagentNotificationText(run),
      display: true,
      details: subagentToolDetails(run),
    }, { deliverAs: "followUp", triggerTurn: true });
    // pi starts the turn before its first await, and resolves only once that turn settled. From
    // here the parent's own run stands for this result: its end must not see the result as pending.
    if (parent.isRunning()) onTurnStarted();
    await delivery;
  }

  async function abort(sessionId: string): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    const stored = getSubagentRuns().get(sessionId);
    if (stored?.run.status === "queued") {
      stored.abortRequested = true;
      if (!stored.cancelQueued?.()) throw new Error("Subagent is no longer queued");
      return;
    }
// Still connecting its MCP servers: no run to stop yet, so the wait ends instead.
    if (stored?.mcpWait) {
      stored.abortRequested = true;
      stored.mcpWait.abort();
      return;
    }
    if (!wrapper?.isAlive() || !wrapper.isRunning()) {
      // pi-team parks a member through host.stop. The wrapper is often already
      // gone by then, so there is nothing to abort — but the run record must not
      // stay active/running, or every later revive is refused as "already
      // running". Settle it here and make stop idempotent.
      if (stored) {
        stored.abortRequested = true;
        stored.active = false;
        stored.run = settleOrphanedRun(stored.run);
        if (getSubagentRuns().get(sessionId) === stored) getSubagentRuns().delete(sessionId);
      }
      return;
    }
    if (stored) stored.abortRequested = true;
    await wrapper.inner.abort();
  }

  function settleDirectTurn(sessionId: string, aborted: boolean): void {
    // A run in the map records its own result, and a settled run keeps its report.
    if (getSubagentRuns().has(sessionId)) return;
    const wrapper = dependencies.getSession(sessionId);
    if (!wrapper?.isAlive()) return;
    const manager = wrapper.inner.sessionManager;
    const run = readSubagentRun(manager.getEntries() as unknown as SessionEntry[], sessionId, wrapper.sessionFile);
    if (!run || (run.status !== "running" && run.status !== "queued")) return;
    const text = wrapper.inner.getLastAssistantText()?.trim();
    const stop = aborted ? undefined : lastAssistantStop(manager);
    recordResult(manager, {
      ...run,
      status: aborted || stop?.aborted ? "aborted" : stop?.error ? "failed" : "completed",
      completedAt: new Date().toISOString(),
      ...(text ? { result: text } : {}),
      ...(stop?.error ? { error: stop.error } : {}),
    });
    dependencies.invalidateSessionList();
  }

  return {
    extensionRuntime: { start, resume, get, steer, notifyParent, markResultConsumed },
    get,
    steer,
    abort,
    settleDirectTurn,
  };
}
