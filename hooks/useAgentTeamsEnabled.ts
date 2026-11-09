import { useEffect, useRef, useSyncExternalStore } from "react";
import { APP_PREF_KEYS, getPref, setPref } from "@/lib/app-prefs";
import { hasAgentTeamRequest } from "@/lib/agent-team-request";

/**
 * Agent Team 的两个开关状态（A1 拆分）。
 *
 * 原来的一个布尔既当「全局开关」又当「下一条消息 armed」，还把 armed 默认成开；现在拆成
 * 互相独立的两态：
 *
 * - `useAgentTeamsEnabled()`：**全局可用性**。默认开、落 localStorage。它是「这个功能对
 *   这个用户是否可用」的长期偏好，关掉后 composer 不该再提供单条团队开关。
 * - `useAgentTeamsArmed(sessionKey)`：**单条 armed**。默认关、**不落盘**（纯内存态）、
 *   按会话键隔离。勾选表示「**下一条**消息用团队处理」；带团队指令的消息发出去后立刻复位
 *   关，后续闲聊不再累积建团指令。命令类消息（`/`、`!`）原样发送、被豁免，不消耗这次 armed。
 *
 * 两态互不干扰：改全局可用性不会动某条的 armed，复位 armed 也不写全局偏好。
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

// ───────────────────────── 单条 armed（内存态，默认关） ─────────────────────────

/**
 * armed 不落盘：它只是「这一条消息」的临时意图，刷新 / 重启后自然归零（即默认关）。
 *
 * 只存在内存里，并绑定一个会话键：`useAgentTeamsArmed(sessionKey)` 在会话切换时把它
 * 重置为关——同一份 composer 在不同会话间切换不会把 armed 串过去。
 */
let armed = false;
/** armed 归属的会话键：无参 `disarmAgentTeam()` 靠它定位，会话切换时也靠它判断要不要重置。 */
let armedSessionKey: string | null = null;
const armedListeners = new Set<() => void>();

function armedSnapshot(): boolean {
  return armed;
}

function subscribeArmed(listener: () => void): () => void {
  armedListeners.add(listener);
  return () => { armedListeners.delete(listener); };
}

/**
 * armed 是否需要因会话切换而重置。
 *
 * 抽成纯函数，方便在没有 DOM 的单测里直接验证「切会话重算」这条规则；真正调用它的是
 * `useAgentTeamsArmed` 的会话切换守卫。
 */
export function shouldResetArmedOnSessionChange(
  previousKey: string | null,
  nextKey: string | null,
): boolean {
  return previousKey !== nextKey;
}

/** 读当前 armed（命令式读取路径；React 组件请用 `useAgentTeamsArmed`）。 */
export function isAgentTeamsArmed(): boolean {
  return armed;
}

/**
 * 把 armed 设为 next（内存态、不落盘）。带 sessionKey 时同时登记它归属哪个会话；
 * 省略则沿用当前归属。值没变就什么都不做，避免无谓的重渲染。
 */
export function setAgentTeamsArmed(next: boolean, sessionKey?: string | null): void {
  const key = sessionKey === undefined ? armedSessionKey : (sessionKey ?? null);
  if (armed === next && armedSessionKey === key) return;
  armed = next;
  armedSessionKey = key;
  armedListeners.forEach((listener) => listener());
}

/** 勾上「下一条用团队」。 */
export function armAgentTeam(sessionKey?: string | null): void {
  setAgentTeamsArmed(true, sessionKey);
}

/**
 * 复位这次 armed：一条带着团队指令的消息发出后调用（`components/ChatInput.tsx` 的
 * handleSend，位置对齐 cc-haha 发送调用之后的 `disarmAgentTeam()`）。已经是关的状态时
 * 什么都不做。签名保持无参可调，兼容既有调用方；需要指定会话时可传 sessionKey。
 */
export function disarmAgentTeam(sessionKey?: string | null): void {
  setAgentTeamsArmed(false, sessionKey);
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
 * 单条 armed：默认关、不落盘、随会话键隔离。
 *
 * 会话切换时**显式重置**为关（用 effect 而不是渲染期赋值——组件渲染必须纯净）：
 * 切过去先清掉上一条会话的 armed。返回前再用 `keyChanged` 兜一层，切会话的第一帧直接
 * 读成「关」，不会闪一下上一条会话的 armed，也就不会在那一帧误发一条带团队块的消息。
 */
export function useAgentTeamsArmed(sessionKey?: string | null): boolean {
  const key = sessionKey ?? null;
  const armedNow = useSyncExternalStore(subscribeArmed, armedSnapshot, () => false);

  const previousKeyRef = useRef<string | null>(key);
  const keyChanged = shouldResetArmedOnSessionChange(previousKeyRef.current, key);
  useEffect(() => {
    // 切会话 → 丢弃上一条 armed（内存态，仅影响本模块）。
    if (keyChanged) setAgentTeamsArmed(false, key);
    previousKeyRef.current = key;
    // keyChanged 只在会话键切换的那一帧为真，切完即假。
  }, [key, keyChanged]);

  return keyChanged ? false : armedNow;
}
