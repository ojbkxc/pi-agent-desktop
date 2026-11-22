"use client";

import { useSyncExternalStore } from "react";
import type { RuntimeControlView } from "@/lib/agent-teams-runtime-control";

/**
 * 团队运行时控件的客户端 store（对齐 cc-haha teamRuntimeControlStore 的可观测语义；
 * 桌面化简：pi 的服务端没有 pausing/resuming 瞬态记录，进行态由客户端表达）。
 *
 * 本仓无 zustand：按 useAgentTeamsEnabled 的既有模式实现成
 * 模块级 store + useSyncExternalStore（hot-reload 下模块重评时快照变量重置——
 * 运行时控件是会话级瞬时态，重置可接受；服务端 sidecar 才是权威）。
 *
 * 范围（scope）= { teamName, leadSessionId, incarnationId }：同一团队不同代际
 * （incarnation）互不串号；按 scopeKey 分桶。
 *
 * 状态语义（cc-haha 同款）：
 * - `pauseRequested`：点了暂停但服务端还没确认。服务端返回的 status 变成非 running
 *   （paused/partial）即确认；15 秒超时未确认 ⇒ 复位并报 pauseUnconfirmed。
 * - `operation: "resume"`：恢复请求进行中。
 * - view 来自 GET /api/teams/[team]/runtime-control，**只有服务端响应能确立
 *   paused/editable 状态**，客户端不持久化任何控制态。
 */

export interface TeamRuntimeScope {
  teamName: string;
  leadSessionId: string;
  incarnationId: string;
}

export interface TeamRuntimeControlEntry {
  view: RuntimeControlView | null;
  loading: boolean;
  busy: boolean;
  operation: "resume" | null;
  pauseRequested: boolean;
  error: string | null;
}

export const EMPTY_TEAM_RUNTIME_CONTROL: TeamRuntimeControlEntry = {
  view: null,
  loading: false,
  busy: false,
  operation: null,
  pauseRequested: false,
  error: null,
};

export function teamRuntimeScope(
  team: { name?: string; leadSessionId?: string | null; incarnationId?: string | null } | null | undefined,
): TeamRuntimeScope | null {
  return team?.name && team.leadSessionId && team.incarnationId
    ? { teamName: team.name, leadSessionId: team.leadSessionId, incarnationId: team.incarnationId }
    : null;
}

export function teamRuntimeControlKey(scope: TeamRuntimeScope): string {
  return JSON.stringify([scope.teamName, scope.leadSessionId, scope.incarnationId]);
}

/** 暂停未确认的超时（cc-haha 同款 15s）。 */
export const PAUSE_CONFIRM_TIMEOUT_MS = 15_000;

export const PAUSE_UNCONFIRMED = "暂停请求未在预期时间内确认（团队成员可能仍在停止），请稍后重试。";

interface TeamRuntimeControlState {
  refresh: (scope: TeamRuntimeScope) => Promise<RuntimeControlView | null>;
  markPauseRequested: (scope: TeamRuntimeScope) => void;
  pause: (scope: TeamRuntimeScope) => Promise<RuntimeControlView | null>;
  resume: (scope: TeamRuntimeScope) => Promise<RuntimeControlView | null>;
}

// ── 模块级 store（useSyncExternalStore 的快照源）─────────────────────────────
//
// **状态挂 globalThis 单例**（lib/scheduled-tasks 同款惯例）：jiti 在测试/无 bundler
// 环境下对同 URL 的每次 import 都建新模块实例，模块级 let/const 不共享——组件与测试
// 旁路 import 拿到的会是两份桶，驱动不到对方。挂 globalThis 后跨实例共享（浏览器与
// Next bundler 下无影响，process 全局唯一）。

interface RuntimeControlStoreState {
  byTeam: Map<string, TeamRuntimeControlEntry>;
  listeners: Set<() => void>;
  storeGeneration: number;
  /** 读失效代际：invalidate() 顶它，让挂着的旧 refresh 结果作废。 */
  generations: Map<string, number>;
  /** 动作代际：markPauseRequested / resume 顶它，串行化并发动作（cc-haha actionGenerations 同款）。 */
  actionGenerations: Map<string, number>;
  reads: Map<string, Promise<RuntimeControlView | null>>;
  pauses: Map<string, Promise<RuntimeControlView | null>>;
  resumes: Map<string, Promise<RuntimeControlView | null>>;
  pauseTimers: Map<string, ReturnType<typeof setTimeout>>;
  pauseRevisions: Map<string, number>;
}

const STORE_KEY = "__piTeamRuntimeControlStore";

function storeState(): RuntimeControlStoreState {
  const holder = globalThis as unknown as Record<string, RuntimeControlStoreState | undefined>;
  return holder[STORE_KEY] ??= {
    byTeam: new Map(),
    listeners: new Set(),
    storeGeneration: 0,
    generations: new Map(),
    actionGenerations: new Map(),
    reads: new Map(),
    pauses: new Map(),
    resumes: new Map(),
    pauseTimers: new Map(),
    pauseRevisions: new Map(),
  };
}

const byTeam = () => storeState().byTeam;
const listeners = () => storeState().listeners;
const storeGeneration = () => storeState().storeGeneration;
const bumpStoreGeneration = () => { storeState().storeGeneration += 1; };
const generations = () => storeState().generations;
const actionGenerations = () => storeState().actionGenerations;
const reads = () => storeState().reads;
const pauses = () => storeState().pauses;
const resumes = () => storeState().resumes;
const pauseTimers = () => storeState().pauseTimers;
const pauseRevisions = () => storeState().pauseRevisions;

function entrySnapshot(): Map<string, TeamRuntimeControlEntry> {
  // 引用在每次 update 时整体替换（见 update），使 useSyncExternalStore 的
  // Object.is 比较能感知变化；原地改 Map 引用不变 = React 不重渲染。
  return byTeam();
}

function subscribe(listener: () => void): () => void {
  listeners().add(listener);
  return () => { listeners().delete(listener); };
}

/** 订阅一个 scope 分桶的控件状态；scope 未定时读空快照（组件返回 null）。 */

export function useTeamRuntimeControlEntry(scopeKey: string | null): TeamRuntimeControlEntry | null {
  // 快照源 = byTeam Map（引用稳定：只有 map 替换才触发重新订阅；内部 set 后由
  // update→emit 通知，引用不变不触发——改为每次返回同一 Map 引用 + 组件自己
  // 按 scopeKey 取桶，与 useAgentTeamsEnabled 的订阅模型一致）。
  // 服务端快照（SSR / hydration 首屏）也返回真实 Map——空桶是正确初始态；
  // 返回恒空快照会让首屏永远读不到已写入的桶。
  const snapshot = useSyncExternalStore(subscribe, entrySnapshot, entrySnapshot);
  return scopeKey ? snapshot.get(scopeKey) ?? null : null;
}

function emit(): void {
  listeners().forEach((listener) => listener());
}

function getEntry(key: string): TeamRuntimeControlEntry {
  return byTeam().get(key) ?? EMPTY_TEAM_RUNTIME_CONTROL;
}

function update(key: string, apply: (entry: TeamRuntimeControlEntry) => TeamRuntimeControlEntry): void {
  const state = storeState();
  const next = new Map(state.byTeam);
  next.set(key, apply(next.get(key) ?? EMPTY_TEAM_RUNTIME_CONTROL));
  state.byTeam = next;
  emit();
}

function invalidate(key: string): void {
  generations().set(key, (generations().get(key) ?? 0) + 1);
  reads().delete(key);
}

function clearPause(key: string): void {
  const timer = pauseTimers().get(key);
  if (timer) clearTimeout(timer);
  pauseTimers().delete(key);
  pauseRevisions().delete(key);
}

/** 接受一次服务端视图：暂停确认 = status 非 running 且 revision 越过发起暂停时的值。 */
function accept(scope: TeamRuntimeScope, view: RuntimeControlView | null): RuntimeControlView | null {
  const key = teamRuntimeControlKey(scope);
  if (view && (view.teamName !== scope.teamName || view.incarnationId !== scope.incarnationId)) {
    // 同名团队换代（或别的团队写进来了）：旧控件不可再操作。
    update(key, (entry) => ({ ...entry, view: null, loading: false, error: "团队身份已变化，请刷新" }));
    return null;
  }
  const current = getEntry(key).view;
  if (view && current && view.revision < current.revision) return current;
  const pauseConfirmed = !view
    || view.status !== "running"
    || view.revision > (pauseRevisions().get(key) ?? Number.POSITIVE_INFINITY);
  if (pauseConfirmed) clearPause(key);
  update(key, (entry) => ({
    ...entry,
    view,
    loading: false,
    error: null,
    pauseRequested: pauseConfirmed ? false : entry.pauseRequested,
  }));
  return view;
}

function fail(key: string, error: unknown): void {
  update(key, (entry) => ({ ...entry, loading: false, error: error instanceof Error ? error.message : String(error) }));
}

/** 服务端动作实现（导出供测试替换 fetch / 直接驱动）。 */
export const teamRuntimeControl: TeamRuntimeControlState = {
  refresh(scope) {
    const key = teamRuntimeControlKey(scope);
    const existing = reads().get(key);
    if (existing) return existing;
    const generation = generations().get(key) ?? 0;
    const storeEpoch = storeGeneration();
    update(key, (entry) => ({ ...entry, loading: !entry.view }));
    const request = Promise.resolve().then(async () => {
      try {
        const response = await fetch(
          `/api/teams/${encodeURIComponent(scope.teamName)}/runtime-control`,
          { cache: "no-store" },
        );
        if (storeEpoch !== storeGeneration() || generation !== (generations().get(key) ?? 0)) {
          return getEntry(key).view;
        }
        if (!response.ok) {
          if (response.status === 404) update(key, (entry) => ({ ...entry, view: null }));
          throw new Error(`读取运行时状态失败（HTTP ${response.status}）`);
        }
        const view = (await response.json()) as RuntimeControlView;
        return accept(scope, view);
      } catch (error) {
        if (storeEpoch !== storeGeneration() || generation !== (generations().get(key) ?? 0)) return null;
        fail(key, error);
        return null;
      } finally {
        if (reads().get(key) === request) reads().delete(key);
      }
    });
    reads().set(key, request);
    return request;
  },
  markPauseRequested(scope) {
    const key = teamRuntimeControlKey(scope);
    clearPause(key);
    const actionGeneration = (actionGenerations().get(key) ?? 0) + 1;
    actionGenerations().set(key, actionGeneration);
    invalidate(key);
    const storeEpoch = storeGeneration();
    resumes().delete(key);
    pauseRevisions().set(key, getEntry(key).view?.revision ?? Number.POSITIVE_INFINITY);
    update(key, (entry) => ({ ...entry, pauseRequested: true, busy: false, operation: null, error: null }));
    pauseTimers().set(key, setTimeout(() => {
      if (storeEpoch !== storeGeneration() || actionGeneration !== (actionGenerations().get(key) ?? 0)) return;
      pauseTimers().delete(key);
      pauseRevisions().delete(key);
      update(key, (entry) => (entry.pauseRequested
        ? { ...entry, pauseRequested: false, error: PAUSE_UNCONFIRMED }
        : entry));
    }, PAUSE_CONFIRM_TIMEOUT_MS));
  },
  pause(scope) {
    const key = teamRuntimeControlKey(scope);
    const existing = pauses().get(key);
    if (existing) return existing;
    const storeEpoch = storeGeneration();
    const actionGeneration = (actionGenerations().get(key) ?? 0) + 1;
    actionGenerations().set(key, actionGeneration);
    update(key, (entry) => ({ ...entry, busy: true, error: null }));
    const operation = Promise.resolve().then(async () => {
      try {
        const response = await fetch(
          `/api/teams/${encodeURIComponent(scope.teamName)}/runtime-control`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "pause",
              leadSessionId: scope.leadSessionId,
              incarnationId: scope.incarnationId,
            }),
          },
        );
        if (storeEpoch !== storeGeneration() || actionGeneration !== (actionGenerations().get(key) ?? 0)) {
          return getEntry(key).view;
        }
        const data = (await response.json().catch(() => ({}))) as { error?: string } & Partial<RuntimeControlView>;
        if (!response.ok) throw new Error(data.error ?? `暂停失败（HTTP ${response.status}）`);
        invalidate(key);
        return accept(scope, data as RuntimeControlView);
      } catch (error) {
        if (storeEpoch === storeGeneration() && actionGeneration === (actionGenerations().get(key) ?? 0)) {
          // A failed pause must not stay "pausing" until the 15s timeout.
          clearPause(key);
          invalidate(key);
          update(key, (entry) => ({ ...entry, loading: false, pauseRequested: false }));
          fail(key, error);
        }
        throw error;
      } finally {
        if (pauses().get(key) === operation) pauses().delete(key);
        if (storeEpoch === storeGeneration() && actionGeneration === (actionGenerations().get(key) ?? 0)) {
          update(key, (entry) => ({ ...entry, busy: false }));
        }
      }
    });
    pauses().set(key, operation);
    return operation;
  },
  resume(scope) {
    const key = teamRuntimeControlKey(scope);
    const existing = resumes().get(key);
    if (existing) return existing;
    const entry = getEntry(key);
    const view = entry.view;
    if (
      !view
      || entry.busy
      || entry.pauseRequested
      || (view.status !== "paused" && view.status !== "partial")
      || view.teamName !== scope.teamName
      || view.incarnationId !== scope.incarnationId
    ) {
      return Promise.reject(new Error("团队状态已变化，请刷新后重试"));
    }
    const storeEpoch = storeGeneration();
    const actionGeneration = (actionGenerations().get(key) ?? 0) + 1;
    actionGenerations().set(key, actionGeneration);
    // 不调 invalidate：refresh 代的 generations 与动作代无关，busy/operation 已就地更新。
    update(key, (current) => ({ ...current, busy: true, operation: "resume", error: null }));
    const operation = Promise.resolve().then(async () => {
      try {
        const response = await fetch(
          `/api/teams/${encodeURIComponent(scope.teamName)}/runtime-control`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "resume",
              leadSessionId: scope.leadSessionId,
              incarnationId: scope.incarnationId,
            }),
          },
        );
        if (storeEpoch !== storeGeneration() || actionGeneration !== (actionGenerations().get(key) ?? 0)) {
          return getEntry(key).view;
        }
        const data = (await response.json().catch(() => ({}))) as { error?: string } & Partial<RuntimeControlView>;
        if (!response.ok) throw new Error(data.error ?? `恢复失败（HTTP ${response.status}）`);
        invalidate(key);
        return accept(scope, data as RuntimeControlView);
      } catch (error) {
        if (storeEpoch === storeGeneration() && actionGeneration === (actionGenerations().get(key) ?? 0)) {
          invalidate(key);
          fail(key, error);
        }
        throw error;
      } finally {
        if (resumes().get(key) === operation) resumes().delete(key);
        if (storeEpoch === storeGeneration() && actionGeneration === (actionGenerations().get(key) ?? 0)) {
          update(key, (current) => ({ ...current, busy: false, operation: null }));
        }
      }
    });
    resumes().set(key, operation);
    return operation;
  },
};

// ── 测试钩子（node:test 直驱模块级 store；生产代码不用）──────────────────────

/** 读某 scope 的当前条目（测试用）。 */
export function teamRuntimeControlEntryForTest(scope: TeamRuntimeScope): TeamRuntimeControlEntry {
  return getEntry(teamRuntimeControlKey(scope));
}

/** 清空全部客户端状态（测试隔离用；服务端 sidecar 不受影响）。 */
export function resetTeamRuntimeControlForTest(): void {
  bumpStoreGeneration();
  const state = storeState();
  for (const timer of state.pauseTimers.values()) clearTimeout(timer);
  state.pauseTimers.clear();
  state.pauseRevisions.clear();
  state.generations.clear();
  state.actionGenerations.clear();
  state.reads.clear();
  state.pauses.clear();
  state.resumes.clear();
  state.byTeam.clear();
  emit();
}
