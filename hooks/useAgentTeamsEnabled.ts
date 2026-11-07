import { useSyncExternalStore } from "react";
import { APP_PREF_KEYS, getPref, setPref } from "@/lib/app-prefs";
import { hasAgentTeamRequest } from "@/lib/agent-team-request";

/**
 * Agent Team 的 armed 开关（Settings › General › Chat）。
 *
 * **一次性 armed**（对齐 cc-haha 的 `useState(false)` + `disarmAgentTeam()`）：勾选表示
 * 「下一条消息用团队处理」，真正带着团队指令（`lib/agent-team-request.ts`）发出去之后
 * 立刻复位关；后续闲聊不再自动建团，也不会每轮累积团队指令。命令类消息（`/`、`!`）
 * 不包装、不消耗这次 armed。
 *
 * 首次使用（localStorage 没有记录）默认开；复位后偏好写成 "false"，下次要用再勾上。
 * 偏好与发送键模式等其它应用偏好同一套 localStorage 存储。
 */
export const AGENT_TEAMS_ENABLED_DEFAULT = true;

/** localStorage 值 → armed。只有明确的 "false" 算关；没存过（null）按默认开。 */
export function parseAgentTeamsEnabled(raw: string | null): boolean {
  return raw === null ? AGENT_TEAMS_ENABLED_DEFAULT : raw === "true";
}

/**
 * 一条消息发出后，这次 armed 是否被消耗（`components/ChatInput.tsx` 的 handleSend 用它
 * 决定要不要 `disarmAgentTeam()`）。
 *
 * 只有**真的带上了团队块**的消息才算数：命令类消息（`/`、`!`）被
 * `isAgentTeamCommand` 豁免、原样发送，不消耗这次勾选，留给下一条真正的提示。
 */
export function shouldDisarmAgentTeam(enabled: boolean, sentMessage: string): boolean {
  return enabled && hasAgentTeamRequest(sentMessage);
}

function readStored(): boolean {
  return parseAgentTeamsEnabled(getPref(APP_PREF_KEYS.agentTeamsEnabled));
}

let enabled: boolean | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): boolean {
  if (enabled === null) enabled = readStored();
  return enabled;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setAgentTeamsEnabled(next: boolean): void {
  enabled = next;
  setPref(APP_PREF_KEYS.agentTeamsEnabled, String(next));
  listeners.forEach((listener) => listener());
}

/**
 * 消耗这次 armed：一条带着团队指令的消息发出后调用（`components/ChatInput.tsx` 的
 * handleSend，位置对齐 cc-haha 发送调用之后的 `disarmAgentTeam()`）。已经是关的状态
 * 时什么都不做，避免无谓的 localStorage 写入与重渲染。
 */
export function disarmAgentTeam(): void {
  if (!getSnapshot()) return;
  setAgentTeamsEnabled(false);
}

export function useAgentTeamsEnabled(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => AGENT_TEAMS_ENABLED_DEFAULT);
}
