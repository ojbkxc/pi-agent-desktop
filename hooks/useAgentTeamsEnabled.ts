import { useSyncExternalStore } from "react";
import { APP_PREF_KEYS, getPref, setPref } from "@/lib/app-prefs";

/**
 * Agent Team 开关（composer 的「用团队处理」）。
 *
 * **默认开**：打开时，发送的消息会前置一段团队指令（`lib/agent-team-request.ts`），
 * 让模型建团队把活拆下去；关掉后消息按原样发送。偏好存在 localStorage，与其它
 * 应用偏好（发送键模式、侧栏宽度等）同一套存储。
 */
export const AGENT_TEAMS_ENABLED_DEFAULT = true;

function readStored(): boolean {
  const raw = getPref(APP_PREF_KEYS.agentTeamsEnabled);
  // 只有明确的 "false" 才算关；没存过（null）按默认开。
  return raw === null ? AGENT_TEAMS_ENABLED_DEFAULT : raw === "true";
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

export function useAgentTeamsEnabled(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => AGENT_TEAMS_ENABLED_DEFAULT);
}
