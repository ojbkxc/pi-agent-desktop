import { useSyncExternalStore } from "react";
import { APP_PREF_KEYS, getPref, setPref } from "@/lib/app-prefs";
import { hasAgentTeamRequest } from "@/lib/agent-team-request";

/**
 * Agent Team 的两个开关状态。
 *
 * - `useAgentTeamsEnabled()`：**全局可用性**。默认开、落 localStorage。它是「这个功能对
 *   这个用户是否可用」的长期偏好，关掉后 composer 不再提供单条团队开关。
 * - `useAgentTeamsArmed(sessionKey)`：**单条 armed**。默认关、**不落盘**（纯内存态）、
 *   **按会话键分别记忆**。勾选表示「**下一条**消息用团队处理」；带团队指令的消息发出去后
 *   该会话立刻复位关，后续闲聊不再累积建团指令。命令类消息（`/`、`!`）原样发送、被豁免，
 *   不消耗这次 armed。
 *
 * 为什么按会话记（2026-11-12 用户口径）：cc-haha 的 armed 是常驻 composer 的局部状态，
 * 切走再切回来**还是离开时的样子**。本仓原先是「切会话即归零」，用户实测后要求对齐 ——
 * 「给某个会话打开了团队，切到别的会话再切回来，应该还是打开的状态」。
 * 这里用一张按会话键的 Map 做到「每会话各自记住」，同时**不串台**（cc-haha 的常驻状态
 * 会串到别的会话；本仓按 key 分开，切到没勾过的会话仍然是关）。
 *
 * 两态互不干扰：改全局可用性不会动任何会话的 armed，复位 armed 也不写全局偏好。
 */

// ───────────────────────── 全局可用性（持久化，默认开） ─────────────────────────

/** 全局可用性的默认值：首次使用（没存过）默认开。 */
export const AGENT_TEAMS_ENABLED_DEFAULT = true;

/** localStorage 值 → 全局可用性。只有明确的 "false" 算关；没存过（null）按默认开。 */
export function parseAgentTeamsEnabled(raw: string | null): boolean {
  return raw === null ? AGENT_TEAMS_ENABLED_DEFAULT : raw === "true";
}

function readStoredEnabled(): boolean {
  return parseAgentTeamsEnabled(getPref(APP_PREF_KEYS.agentTeamsEnabled));
}

let enabled: boolean | null = null;
const enabledListeners = new Set<() => void>();

function enabledSnapshot(): boolean {
  if (enabled === null) enabled = readStoredEnabled();
  return enabled;
}

function subscribeEnabled(listener: () => void): () => void {
  enabledListeners.add(listener);
  return () => { enabledListeners.delete(listener); };
}

/** 写全局可用性并落盘（Settings › General › Chat 的开关用它）。 */
export function setAgentTeamsEnabled(next: boolean): void {
  enabled = next;
  setPref(APP_PREF_KEYS.agentTeamsEnabled, String(next));
  enabledListeners.forEach((listener) => listener());
}

/** 全局可用性：默认开、落 localStorage、跨刷新保留。 */
export function useAgentTeamsEnabled(): boolean {
  return useSyncExternalStore(subscribeEnabled, enabledSnapshot, () => AGENT_TEAMS_ENABLED_DEFAULT);
}

// ───────────────────────── 单条 armed（内存态，按会话键记忆） ─────────────────────────

/** 无会话键时（极少数路径，如未挂载草稿）用的键；与真实会话 id 不会撞。 */
export const UNSCOPED_AGENT_TEAM_KEY = "unscoped";

/**
 * armed 不落盘：它只是「这一条消息」的临时意图，刷新 / 重启后自然归零（即全部关）。
 *
 * 键是**会话键**（ChatInput 的 `draftKey`：真实会话 id，或新建会话的 `new:<id>:<cwd>`）。
 * `false` / 键不存在都读作关；只有显式 `true` 才安全 —— 这样 Map 里不必存一堆 false。
 *
 * 注意 `unscoped` 键：`ChatInput` 在某些极窄场景（例如引用浮层里的紧凑 composer）没有
 * draftKey，那里勾了也无处可记，就统一落在 `unscoped` 上，不影响任何真实会话。
 */
const armedBySession = new Map<string, boolean>();
const armedListeners = new Set<() => void>();
/**
 * 每次改动自增。`useSyncExternalStore` 的 getSnapshot 必须返回**稳定可比较**的值，而
 * 「当前会话是否 armed」取决于组件传入的 key —— 让快照只报告版本号，组件再用当前 key 去
 * Map 里取值，就同时满足「key 变化立刻读到正确值」与「任何一个会话改动都会触发重渲染」。
 */
let armedVersion = 0;

function scopeKey(sessionKey?: string | null): string {
  const trimmed = typeof sessionKey === "string" ? sessionKey.trim() : "";
  return trimmed || UNSCOPED_AGENT_TEAM_KEY;
}

function armedVersionSnapshot(): number {
  return armedVersion;
}

function subscribeArmed(listener: () => void): () => void {
  armedListeners.add(listener);
  return () => { armedListeners.delete(listener); };
}

function notifyArmedChanged(): void {
  armedVersion += 1;
  armedListeners.forEach((listener) => listener());
}

/** 读某个会话的 armed；没记过就是关。 */
export function isAgentTeamsArmed(sessionKey?: string | null): boolean {
  return armedBySession.get(scopeKey(sessionKey)) === true;
}

/**
 * 把某个会话的 armed 设为 next（内存态、不落盘）。
 *
 * 值没变就什么都不做，避免无谓的重渲染。
 */
export function setAgentTeamsArmed(next: boolean, sessionKey?: string | null): void {
  const key = scopeKey(sessionKey);
  const previous = armedBySession.get(key) === true;
  if (previous === next) return;
  armedBySession.set(key, next);
  notifyArmedChanged();
}

/** 勾上「下一条用团队」。 */
export function armAgentTeam(sessionKey?: string | null): void {
  setAgentTeamsArmed(true, sessionKey);
}

/**
 * 复位这次 armed：一条带着团队指令的消息发出后调用（`components/ChatInput.tsx` 的
 * handleSend，位置对齐 cc-haha 发送调用之后的 `disarmAgentTeam()`）。已经是关的状态时
 * 什么都不做。需要指定会话时可传 sessionKey。
 */
export function disarmAgentTeam(sessionKey?: string | null): void {
  setAgentTeamsArmed(false, sessionKey);
}

/** 清空所有会话的 armed（单测与「重置」用；生产路径不调用）。 */
export function resetAllAgentTeamsArmed(): void {
  if (armedBySession.size === 0) return;
  armedBySession.clear();
  notifyArmedChanged();
}

/**
 * 一条消息发出后，这次 armed 是否被消耗（`components/ChatInput.tsx` 的 handleSend 用它
 * 决定要不要 `disarmAgentTeam()`）。
 *
 * 只有**真的带上了团队块**的消息才算数：命令类消息（`/`、`!`）被 `isAgentTeamCommand`
 * 豁免、原样发送，不消耗这次 armed，留给下一条真正的提示。
 */
export function shouldDisarmAgentTeam(armedNow: boolean, sentMessage: string): boolean {
  return armedNow && hasAgentTeamRequest(sentMessage);
}

/**
 * armed 的会话键。
 *
 * 真实会话直接用会话 id。**新建会话**（还没发出第一条消息）用 `new:<cwd>` —— 而不是
 * ChatInput 草稿键里的 `new:<draftId>:<cwd>`：那个 draftId 每次点「新建」都换一个，会让
 * 「勾了团队 → 点新建」把开关丢掉；cc-haha 在同样操作下仍是同一个 composer、开关保持
 * 打开，用户要求对齐。发出第一条消息后键变成真实会话 id，当前的 armed 也就用不上了
 * （发送即复位）。
 */
export function agentTeamScopeKey(
  sessionId?: string | null,
  newSessionCwd?: string | null,
): string | null {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (id) return id;
  const cwd = typeof newSessionCwd === "string" ? newSessionCwd.trim() : "";
  return cwd ? `new:${cwd}` : null;
}

/**
 * 单条 armed：默认关、不落盘、**按会话键分别记忆**。
 *
 * 切会话**不再**归零：每个会话各自记住自己的 armed（切回原会话恢复原状，对齐 cc-haha）。
 * 未勾过的会话读作关，所以也不会串台。
 */
export function useAgentTeamsArmed(sessionKey?: string | null): boolean {
  const key = scopeKey(sessionKey);
  // 订阅版本号（任何会话改动都会重渲染），再从 Map 里按当前 key 取值 —— 于是切回一个
  // 之前 armed 过的会话时，第一帧就是打开的状态，不会闪。
  useSyncExternalStore(subscribeArmed, armedVersionSnapshot, () => 0);
  return armedBySession.get(key) === true;
}