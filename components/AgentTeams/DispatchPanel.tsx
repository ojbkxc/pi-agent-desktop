"use client";

/**
 * 调度建议与一键调度动作面板（#58，#55 第二段）。
 *
 * 数据：GET /api/teams/[team]/workload（v5 稳定契约，design-54.md §一.0）——
 * 只读建议，独立 fetch、失败只在本面板降级提示，**不阻断原画布**（泳道/编队带/
 * 统计头零依赖本面板）；无新定时器，刷新随快照节奏（snapshotStamp）+ 手动按钮。
 *
 * 动作（lead 拍板的硬边界）：系统只检测与建议；首分配/pending-orphan 改派/加成员
 * 一律用户两段式显式确认后才 POST；running（含 orphan-running）永不出现建议，
 * 面板底部固定说明「先等完成或先停旧任务」（如实禁用而非假成功）；按钮在途禁双击
 * （clientRequestId + 逐行在途闸）；消费 delivery.outcome 如实渲染——woken 只写
 * 「已投递，唤醒中」，绝不写「已执行」；仅 failed 给重试（同 clientRequestId 重发，
 * sidecar 幂等由后端兜底）；skipped 无重试；409 给「刷新」重取代际，不自动重发。
 *
 * 并发口径（「多派成员、多并发」）：派发闸是**逐行**的，不是面板级的。
 * 以前 execute 与 submitMembers 共用一个面板级单飞 ref：任一行在途时，其他行的
 * 「确认」/「重试」都直接 return（连提示都没有），20 条建议只能一条条串着点，等于
 * 把「多并发」按死在 UI 上。现在：
 *   - 同一行在途 → 该行按钮禁用（防重复派活，幂等只是兜底）；
 *   - 不同行 → 可同时在途，受 DISPATCH_MAX_CONCURRENCY 与 DISPATCH_GAP_MS 约束；
 *   - 批量「全部派发」= 一次性第二段确认，然后按同一并发池扇出，逐行结果各自落地；
 *   - 加成员一次可提交多个名字（POST members 单请求上限 8，超出自动分块并发，
 *     块失败只标该块成员，绝不中断其余块）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AppSelect } from "@/components/AppSelect";
import type { TranslationParams } from "@/lib/i18n/types";

/** v5 稳定契约（design-54.md §一.0）：workload 只读响应。 */
export interface WorkloadMember {
  name: string;
  state: "running" | "pending" | "idle" | "orphan";
  runningCount: number;
  pendingCount: number;
}
export interface WorkloadOrphan {
  ticketId: string;
  assignmentId: string;
  assignee: string;
  status: "pending" | "running";
}
export interface DispatchSuggestion {
  kind: "assign" | "reassign" | "add-member";
  ticketId: string;
  assignmentId?: string;
  fromMember?: string;
  toMember?: string;
  /** 后端真实契约：毫秒时间戳（number）。改派请求体原样带回，route 校验
   *  typeof === "number" 且与票面 updatedAt 全等（design-54 v5 / lib 实现）。 */
  expectedUpdatedAt?: number;
  reason: string;
}
export interface WorkloadQuota {
  perTeamLimit: number;
  globalLimit: number;
  rosterWorkers: number;
  globalWorkers: number;
}
export interface WorkloadResponse {
  members: WorkloadMember[];
  orphans: WorkloadOrphan[];
  suggestions: DispatchSuggestion[];
  quota: WorkloadQuota;
}

/** v5：成员名进邮箱文件路径，格式后端强校验；前端先同款校验避免无效请求。 */
export const MEMBER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 同一时刻允许在途的派发请求数：多行并发，但不把后端（票锁 + 邮箱投递）打成尖峰。 */
export const DISPATCH_MAX_CONCURRENCY = 3;
/** 相邻两条派发请求的最小起点间隔（毫秒）：把并发起点错开，避免瞬时 burst。 */
export const DISPATCH_GAP_MS = 120;
/**
 * POST /members 单请求携带的成员数。
 *
 * route 的两代契约：早期只收 1..8（超了整单 400），现在放宽到 64
 * （lib/agent-teams-members.ts 的 MAX_BATCH_ADD_MEMBERS，批内还会按
 * PI_TEAM_MAX_SPAWN_CONCURRENCY 并发 spawn）。前端取 8 的理由：
 *  1. 两份契约都成立（不依赖服务端版本）；
 *  2. 分块后每块回来就能合并回执 → 「已加 N/总数」可见，不必等一整批；
 *  3. 传输层失败只影响一块，其余块照常 spawn。
 * 一块 8 个 × 2 路并发，20~60 个成员仍是十几条并发请求，而不是一条条串。
 */
export const ADD_MEMBER_MAX_PER_REQUEST = 8;
/** 加成员分块间并发：spawn 很重（起会话 + 写工作目录），2 路足够。 */
export const ADD_MEMBER_MAX_CONCURRENCY = 2;
/** 加成员分块间的节流（毫秒）。 */
export const ADD_MEMBER_GAP_MS = 150;

type Translator = (key: string, params?: TranslationParams) => string;

/** 建议行稳定 key（同票同派活同代际唯一）。
 *
 * 代际（expectedUpdatedAt）纳入 key：改派建议的 expects 随票面 updatedAt 变化——同一
 * 派活被重新分配后 assignmentId/expectedUpdatedAt 都变。以前只拼 `kind:ticketId:assignmentId`，
 * 旧代际的失败/冲突文案会挂到新建议行上；纳入 generation 后，旧结果天然落到别的 key，
 * 配合 refresh 后的 pruneRowResults 一起清掉。
 */
export function suggestionRowKey(s: DispatchSuggestion): string {
  return `${s.kind}:${s.ticketId}:${s.assignmentId ?? ""}:${s.expectedUpdatedAt ?? ""}`;
}

/**
 * clientRequestId 生成。
 *
 * 为什么不能裸调 `crypto.randomUUID()`：它只在安全上下文（https / localhost）存在。
 * 从局域网 `http://192.168.x.x:30141` 打开工作台时它是 undefined，原实现会在
 * execute 的第一行就抛 TypeError——而且发生在 try 之外，于是变成未捕获的 Promise
 * rejection：按钮点下去毫无反应、也没有任何提示。这里做兜底（仍是唯一 id，亦满足
 * 后端 128 字符上限与 sidecar 幂等口径）。
 */
export function newClientRequestId(
  source: (() => string) | undefined = globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
): string {
  if (typeof source === "function") {
    try {
      const id = source();
      if (typeof id === "string" && id) return id;
    } catch {
      // 落到下面的兜底，绝不把异常抛给调用方（点击必须始终有结果）。
    }
  }
  return `req-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

/** 名字拆分结果：有效名（去重后）、重复名、非法名（原样回显给用户）。 */
export interface ParsedMemberNames {
  names: string[];
  duplicates: string[];
  invalid: string[];
}

/**
 * 一次解析多个成员名（逗号/顿号/分号/空白/换行任意分隔）。
 *
 * 为什么需要：后端 POST members 单请求接受 1..8 个成员，而面板以前只有一个名字输入框
 * ——20 个成员就是 20 次输入 + 20 次往返。批量输入是「多派成员」的第一道闸。
 * 去重按小写（与 route 内 `name.toLowerCase()` 口径一致：重复名会被后端静默丢弃，
 * 前端不去重就会出现「提交 3 个、只回执 2 条」的错位）。
 */
export function parseMemberNames(raw: string): ParsedMemberNames {
  const seen = new Set<string>();
  const names: string[] = [];
  const duplicates: string[] = [];
  const invalid: string[] = [];
  for (const token of raw.split(/[\s,，、;；]+/)) {
    const name = token.trim();
    if (!name) continue;
    if (!MEMBER_NAME_PATTERN.test(name)) {
      if (!invalid.includes(name)) invalid.push(name);
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      if (!duplicates.includes(name)) duplicates.push(name);
      continue;
    }
    seen.add(key);
    names.push(name);
  }
  return { names, duplicates, invalid };
}

/** 按后端单请求上限切块（空数组 → 空块列表，不构造空请求）。 */
export function chunkMemberNames(
  names: readonly string[],
  size: number = ADD_MEMBER_MAX_PER_REQUEST,
): string[][] {
  const limit = Math.max(1, Math.floor(size) || 1);
  const chunks: string[][] = [];
  for (let index = 0; index < names.length; index += limit) {
    chunks.push(names.slice(index, index + limit));
  }
  return chunks;
}

/** 有上限的并发执行结果：worker 抛错的条目按索引如实带回，不吞、不中断其余。 */
export interface ConcurrencyOutcome {
  failures: { index: number; error: unknown }[];
}

/**
 * 有界并发 + 起点节流。
 *
 * 三条硬要求（都是这把闸存在的原因）：
 *  1. `Promise.all` 直接扇出一整批请求会同时炸后端，需要上限；
 *  2. 单条失败不能中断其余（`Promise.all` 一旦 reject，别的成功结果就再也拿不到）；
 *     所以单条异常在这里被收进 failures，其余条目照常跑完；
 *  3. 起点要错开（gapMs），否则上限只限制了 in-flight 数，却仍是同一毫秒的 burst。
 *
 * worker 自己负责把「业务失败」写进界面状态；这里只兜「worker 自身抛错」。
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  options: { gapMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ConcurrencyOutcome> {
  const failures: { index: number; error: unknown }[] = [];
  if (items.length === 0) return { failures };
  const lanes = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const gapMs = Math.max(0, options.gapMs ?? 0);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let cursor = 0;
  const run = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      if (gapMs > 0 && index > 0) await sleep(gapMs);
      try {
        await worker(items[index], index);
      } catch (failure) {
        // 单条异常收进 failures：绝不因一条失败中断其余（下面的 sorted 保证顺序可读）。
        failures.push({ index, error: failure });
      }
    }
  };
  await Promise.all(Array.from({ length: lanes }, run));
  failures.sort((left, right) => left.index - right.index);
  return { failures };
}

/** 逐成员回执（POST members 的 results 条目）。 */
export interface MemberReceipt {
  name: string;
  status: string;
  reason?: string;
  warning?: string;
}

/**
 * 回执合并（按名字后者覆盖前者）。
 * 批量加成员是分块并发的：每块回来都只带自己那几个成员，必须累积而不是整批替换，
 * 否则后到的块会把先到块的回执冲掉，用户只能看到最后一小撮结果。
 */
export function mergeMemberReceipts(
  prev: readonly MemberReceipt[],
  next: readonly MemberReceipt[],
): MemberReceipt[] {
  const byName = new Map<string, MemberReceipt>();
  for (const receipt of prev) byName.set(receipt.name, receipt);
  for (const receipt of next) byName.set(receipt.name, receipt);
  return [...byName.values()];
}

/** 只接受最新一次 refresh 响应的请求闸：并发/乱序时旧响应一律丢弃。 */
export interface RequestGate {
  /** 开始一次请求，返回自增序号。 */
  begin(): number;
  /** 该序号是否仍是最新一次（旧响应返回 false）。 */
  isLatest(id: number): boolean;
}

/** 建一个自增请求闸（组件用 ref 持有单例）。 */
export function createRequestGate(): RequestGate {
  let latest = 0;
  return {
    begin(): number {
      latest += 1;
      return latest;
    },
    isLatest(id: number): boolean {
      return id === latest;
    },
  };
}

/** POST /assignments 请求体（v5 §一.2）：改派必带 assignmentId+expectedUpdatedAt；
 *  add-member 不走此端点（走 POST members），返回 null 表示不该发这个请求。 */
export function dispatchBody(
  s: DispatchSuggestion,
  toMember: string,
  clientRequestId: string,
): Record<string, unknown> | null {
  if (!toMember) return null;
  if (s.kind === "reassign") {
    if (!s.assignmentId || !s.expectedUpdatedAt) return null;
    return {
      clientRequestId,
      ticketId: s.ticketId,
      assignmentId: s.assignmentId,
      toMember,
      expectedUpdatedAt: s.expectedUpdatedAt,
    };
  }
  if (s.kind === "assign") {
    return { clientRequestId, ticketId: s.ticketId, toMember };
  }
  return null;
}

/** 改派候选：只列 state==="idle" 的成员（v5 定稿——pending 不作接收者、orphan 永不进候选）。 */
export function idleCandidateNames(workload: WorkloadResponse | null): string[] {
  return (workload?.members ?? []).filter((member) => member.state === "idle").map((member) => member.name);
}

/** delivery.outcome → 如实文案（v5 §一.2 文案契约）。枚举外的未知值兜底显示原文：
 *  宁多给出口，不把未知名宣称成任何一种成功。 */
export function outcomeText(outcome: string, error: string | undefined, t: Translator): string {
  switch (outcome) {
    case "injected":
      return t("teams.dispatch.outcome.injected");
    case "woken":
      return t("teams.dispatch.outcome.woken");
    case "revived":
      return t("teams.dispatch.outcome.revived");
    case "buffered":
      return t("teams.dispatch.outcome.buffered");
    case "failed":
      return t("teams.dispatch.outcome.failed", { error: error ?? "" });
    default:
      return outcome;
  }
}

export type RowResult =
  | { phase: "delivered"; text: string }
  | { phase: "skipped"; text: string }
  | { phase: "conflict"; text: string }
  | { phase: "failed"; text: string; clientRequestId: string; body: Record<string, unknown> };

/**
 * 刷新成功后按当前建议集合修剪行结果：建议消失或代际变化（assignmentId / expectedUpdatedAt
 * 改变 → key 变）的旧结果一并清掉，避免把上一代际的失败/冲突文案挂到新建议上。
 * 无变化时返回原对象，避免无谓重渲染。
 */
export function pruneRowResults(
  prev: Record<string, RowResult>,
  suggestions: DispatchSuggestion[],
): Record<string, RowResult> {
  const live = new Set(suggestions.map(suggestionRowKey));
  let changed = false;
  const next: Record<string, RowResult> = {};
  for (const [key, value] of Object.entries(prev)) {
    if (live.has(key)) next[key] = value;
    else changed = true;
  }
  return changed ? next : prev;
}

/** 行内节点的焦点槽位（批量操作后别把焦点丢到 body）。 */
interface RowNodes {
  execute?: HTMLElement | null;
  confirm?: HTMLElement | null;
  result?: HTMLElement | null;
}

type FocusTarget = "execute" | "confirm" | "result";

export function DispatchPanel({
  team,
  snapshotStamp,
  ticketSubjects,
}: {
  team: string | null;
  /** workbench 快照的 generatedAt：快照更新即随节奏重拉建议（无独立定时器）。 */
  snapshotStamp?: string | null;
  /** ticketId → subject（来自既有快照，纯展示用；缺票回退显示 ticketId）。 */
  ticketSubjects?: Record<string, string>;
}) {
  const { t } = useI18n();
  const [workload, setWorkload] = useState<WorkloadResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [batchConfirming, setBatchConfirming] = useState(false);
  const [selectedTo, setSelectedTo] = useState<Record<string, string>>({});
  // 逐行在途集合（不是单个 key）：多行并发时互相不能覆盖。
  const [pendingRows, setPendingRows] = useState<string[]>([]);
  const [rowResults, setRowResults] = useState<Record<string, RowResult>>({});
  // 加成员表单（仅 add-member 建议行内展开）：名字支持一次多个（逗号/空格/换行分隔）。
  const [addNames, setAddNames] = useState("");
  const [addAgentType, setAddAgentType] = useState("");
  const [addModel, setAddModel] = useState("");
  const [membersPending, setMembersPending] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [memberReceipts, setMemberReceipts] = useState<MemberReceipt[] | null>(null);
  const [membersProgress, setMembersProgress] = useState<{ done: number; total: number } | null>(null);
  // 焦点托管：展开确认区 / 回执落地时，把焦点放到对应节点（绝不丢到 body）。
  const [focusRequest, setFocusRequest] = useState<{ key: string; target: FocusTarget; nonce: number } | null>(null);
  const rowNodesRef = useRef(new Map<string, RowNodes>());
  const pendingRowsRef = useRef<Set<string>>(new Set());
  const membersPendingRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);
  // 自增请求闸：快照节奏 + 手动刷新可能并发，只接受最新一次响应（先发后到的旧响应丢弃）。
  const gateRef = useRef<RequestGate | null>(null);
  if (gateRef.current === null) gateRef.current = createRequestGate();

  const setRowNodes = useCallback((key: string, slot: keyof RowNodes, node: HTMLElement | null) => {
    const current = rowNodesRef.current.get(key) ?? {};
    current[slot] = node;
    rowNodesRef.current.set(key, current);
  }, []);

  useEffect(() => {
    if (!focusRequest) return;
    const node = rowNodesRef.current.get(focusRequest.key)?.[focusRequest.target];
    // 目标不存在（行已被刷新移除）就保持焦点原地：宁可不动，也不把焦点丢到 body。
    if (node && typeof node.focus === "function") node.focus({ preventScroll: true });
    setFocusRequest(null);
  }, [focusRequest]);

  // 切团队必须清空上一支团队的建议与行状态：建议里的 ticketId 是**该团队**的票 id，
  // 带着旧快照去点「确认」会把 A 队的建议投到 B 队（票 id 撞车就是真的错误派活）。
  useEffect(() => {
    setWorkload(null);
    setRowResults({});
    setPendingRows([]);
    pendingRowsRef.current.clear();
    setConfirming(null);
    setBatchConfirming(false);
    setSelectedTo({});
    setMemberReceipts(null);
    setMembersError(null);
    setMembersProgress(null);
    rowNodesRef.current.clear();
  }, [team]);

  const refresh = useCallback(async () => {
    if (!team) {
      setWorkload(null);
      setLoadError(null);
      return;
    }
    const gate = gateRef.current;
    if (!gate) return;
    const requestId = gate.begin();
    setLoading(true);
    try {
      const response = await fetch(`/api/teams/${encodeURIComponent(team)}/workload`, { cache: "no-store" });
      if (!aliveRef.current || !gate.isLatest(requestId)) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as WorkloadResponse;
      if (!aliveRef.current || !gate.isLatest(requestId)) return;
      setWorkload(data);
      setLoadError(null);
      // 建议集合换代：清掉已消失/代际变化对应的行结果，避免旧文案串到新建议。
      setRowResults((prev) => pruneRowResults(prev, data.suggestions));
    } catch (error) {
      // 只降级本面板：原画布（泳道/编队带/统计头）不消费本面板任何状态。
      // 关键：**不清空 workload**。快照节奏下每 2s 一拉，一次瞬时失败若把建议列表
      // 连同在途行的回执一起抹掉，用户会以为「建议消失了 / 派发丢了」，而且空态文案
      // 「当前没有调度建议」会撒谎（其实是加载失败）。保留上一份成功快照 + 错误条。
      if (!aliveRef.current || !gate.isLatest(requestId)) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (aliveRef.current && gate.isLatest(requestId)) setLoading(false);
    }
  }, [team]);

  useEffect(() => {
    void refresh();
  }, [refresh, snapshotStamp]);

  /** 单条派发的核心（不碰焦点）：调用方负责在合适时机把焦点放到结果上。 */
  const executeOne = useCallback(async (
    suggestion: DispatchSuggestion,
    toMember: string,
    reuseRequestId?: string,
  ): Promise<void> => {
    const rowKey = suggestionRowKey(suggestion);
    if (!team) return;
    const body = dispatchBody(suggestion, toMember, reuseRequestId ?? newClientRequestId());
    if (!body) return;
    // 逐行单飞闸：同一行在途时不再发（防重复派活；后端 sidecar 幂等只是兜底）。
    // 不同行互不阻塞——这是「多派成员、多并发」的落点（旧实现是面板级单飞）。
    if (pendingRowsRef.current.has(rowKey)) return;
    const requestId = body.clientRequestId as string;
    pendingRowsRef.current.add(rowKey);
    setPendingRows((prev) => (prev.includes(rowKey) ? prev : [...prev, rowKey]));
    try {
      const response = await fetch(`/api/teams/${encodeURIComponent(team)}/assignments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!aliveRef.current) return;
      const payload = await response.json().catch(() => ({})) as {
        ok?: boolean;
        error?: string;
        delivery?: { to: string; outcome?: string; error?: string; skipped?: string };
      };
      if (response.status === 409) {
        // 代际过期/running/多主：不自动重发——给「刷新」重取代际，由用户重新确认。
        // 同时收起确认区：留在展开态的「确认」按钮会以新的 clientRequestId 再 POST，
        // 后端幂等拦不住（interaction.md P1）。
        setConfirming((current) => (current === rowKey ? null : current));
        setRowResults((prev) => ({
          ...prev,
          [rowKey]: { phase: "conflict", text: payload.error ?? t("teams.dispatch.conflict") },
        }));
        return;
      }
      if (!response.ok || payload.error) {
        const text = payload.error ?? `HTTP ${response.status}`;
        setRowResults((prev) => ({
          ...prev,
          [rowKey]: { phase: "failed", text, clientRequestId: requestId, body },
        }));
        return;
      }
      const delivery = payload.delivery;
      if (delivery?.skipped) {
        // 已投递过（幂等 sidecar 判定）——不重发，也不给重试按钮。确认区一并收起：
        // 已投递的行不该再留一个可点的「确认」（再点就是重复派活）。
        setConfirming((current) => (current === rowKey ? null : current));
        setRowResults((prev) => ({ ...prev, [rowKey]: { phase: "skipped", text: t("teams.dispatch.skipped") } }));
        return;
      }
      const outcome = delivery?.outcome ?? "failed";
      const text = outcomeText(outcome, delivery?.error, t);
      if (outcome === "failed") {
        setRowResults((prev) => ({
          ...prev,
          [rowKey]: { phase: "failed", text, clientRequestId: requestId, body },
        }));
        return;
      }
      // injected/woken/revived/buffered：如实渲染 outcome 文案——woken 只是「已投递，
      // 唤醒中」，绝不宣称「已执行」。确认区收起，避免同一行被二次确认再次派活
      // （interaction.md P1：成功分支此前只写 rowResults，确认面板仍在）。
      setConfirming((current) => (current === rowKey ? null : current));
      setRowResults((prev) => ({ ...prev, [rowKey]: { phase: "delivered", text } }));
    } catch (error) {
      // 网络层失败：票面变更（ended 不可逆）已发生后投递可能未达——按 failed 给
      // 同 clientRequestId 重试出口，重复投递风险由后端 sidecar 幂等兜底并明示。
      if (!aliveRef.current) return;
      setRowResults((prev) => ({
        ...prev,
        [rowKey]: {
          phase: "failed",
          text: error instanceof Error ? error.message : String(error),
          clientRequestId: requestId,
          body,
        },
      }));
    } finally {
      pendingRowsRef.current.delete(rowKey);
      if (aliveRef.current) {
        setPendingRows((prev) => prev.filter((key) => key !== rowKey));
      }
    }
  }, [team, t]);

  /** 用户点击触发的单条派发：结束后把焦点移到该行结果（键盘/读屏都跟得上）。 */
  const execute = useCallback(async (
    suggestion: DispatchSuggestion,
    toMember: string,
    reuseRequestId?: string,
  ) => {
    await executeOne(suggestion, toMember, reuseRequestId);
    const rowKey = suggestionRowKey(suggestion);
    if (aliveRef.current) {
      setFocusRequest({ key: rowKey, target: "result", nonce: Date.now() });
    }
  }, [executeOne]);

  // 引用身份稳定：workload 每次 2s 刷新都是新对象，但 suggestions 缺省时的 `[]` 不能
  // 每次渲染都换一个新数组，否则下游 useMemo/子组件全部失效（lint exhaustive-deps 报警）。
  const suggestions = useMemo(() => workload?.suggestions ?? [], [workload]);

  /** 可批量派发的行：非 add-member、已有接收者、请求体可构造、还没结果、当前不在途。 */
  const batchTargets = useMemo(() => suggestions.flatMap((suggestion) => {
    if (suggestion.kind === "add-member") return [];
    const rowKey = suggestionRowKey(suggestion);
    const toMember = selectedTo[rowKey] ?? suggestion.toMember ?? "";
    if (!toMember || rowResults[rowKey] || pendingRows.includes(rowKey)) return [];
    // dispatchBody 为 null 的行（缺 assignmentId/expectedUpdatedAt 的改派）不能进批量池：
    // 否则按钮上写着 ×N，点下去有几行静默什么都不做。
    if (!dispatchBody(suggestion, toMember, "probe")) return [];
    return [{ suggestion, rowKey, toMember }];
  }), [suggestions, selectedTo, rowResults, pendingRows]);

  /**
   * 批量派发：一次「全部派发」按钮展开的确认区就是第二段确认（硬边界不变：仍是
   * 用户显式确认后才写），确认后按 DISPATCH_MAX_CONCURRENCY 扇出。逐行结果各自
   * 落到自己的 RowResult（每条都可见），单行失败不影响其余行。
   */
  const runBatch = useCallback(async () => {
    if (!team) return;
    const work = batchTargets;
    setBatchConfirming(false);
    if (work.length === 0) return;
    await runWithConcurrency(
      work,
      DISPATCH_MAX_CONCURRENCY,
      (item) => executeOne(item.suggestion, item.toMember),
      { gapMs: DISPATCH_GAP_MS },
    );
  }, [batchTargets, executeOne, team]);

  const submitMembers = useCallback(async () => {
    if (!team) return;
    const parsedNow = parseMemberNames(addNames);
    if (parsedNow.names.length === 0) return;
    if (membersPendingRef.current) return;
    membersPendingRef.current = true;
    setMembersPending(true);
    setMembersError(null);
    setMemberReceipts(null);
    setMembersProgress({ done: 0, total: parsedNow.names.length });
    const failedNow = new Set<string>();
    let done = 0;
    const role = addAgentType.trim();
    const model = addModel.trim();
    try {
      const chunks = chunkMemberNames(parsedNow.names);
      const { failures } = await runWithConcurrency(chunks, ADD_MEMBER_MAX_CONCURRENCY, async (chunk) => {
        const members = chunk.map((name) => ({
          name,
          ...(role ? { agentType: role } : {}),
          ...(model ? { model } : {}),
        }));
        // 单块失败只标记该块成员，继续跑其余块：整批 Promise.all reject 会把别的块
        // 已经 spawn 成功的回执一起丢掉，用户只能看到一个报错。
        try {
          const response = await fetch(`/api/teams/${encodeURIComponent(team)}/members`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "add", members }),
          });
          const payload = await response.json().catch(() => ({})) as {
            ok?: boolean;
            error?: string;
            results?: MemberReceipt[];
          };
          if (!aliveRef.current) return;
          const results = Array.isArray(payload.results) ? payload.results : [];
          // 逐条回执如实渲染（spawned/respawned/failed）——失败绝不渲染成成功。
          setMemberReceipts((prev) => mergeMemberReceipts(prev ?? [], results));
          // 服务端没给回执的成员（例如整批 409 冲突、或部分被静默拒绝）也要如实落一条
          // 失败，绝不让它们「消失」在结果面板之外。
          const covered = new Set(results.map((receipt) => receipt.name));
          const missing = chunk.filter((name) => !covered.has(name));
          if (missing.length > 0) {
            const reason = payload.error ?? (response.ok ? "" : `HTTP ${response.status}`);
            for (const name of missing) failedNow.add(name);
            setMemberReceipts((prev) => mergeMemberReceipts(
              prev ?? [],
              missing.map((name) => ({ name, status: "failed", reason })),
            ));
            if (reason) setMembersError(reason);
          }
          for (const receipt of results) {
            if (receipt.status === "failed") failedNow.add(receipt.name);
          }
        } catch (error) {
          if (!aliveRef.current) return;
          const message = error instanceof Error ? error.message : String(error);
          for (const name of chunk) failedNow.add(name);
          setMemberReceipts((prev) => mergeMemberReceipts(
            prev ?? [],
            chunk.map((name) => ({ name, status: "failed", reason: message })),
          ));
          setMembersError(message);
        } finally {
          done += chunk.length;
          if (aliveRef.current) setMembersProgress({ done, total: parsedNow.names.length });
        }
      }, { gapMs: ADD_MEMBER_GAP_MS });
      if (failures.length > 0 && aliveRef.current) {
        // 正常路径不会走到这里（worker 已自吞业务异常）；真发生就是编程错误，
        // 如实提示，不假装整批成功。
        setMembersError(failures
          .map((item) => (item.error instanceof Error ? item.error.message : String(item.error)))
          .join("; "));
      }
      // 整批都成功才清空输入框；有失败就**只把失败的名字留在框里**——留着失败项方便
      // 改名重提，同时不把已经 spawn 成功的名字一起再提交一遍（否则第二批会把它们
      // 当成重复成员重派/复活，用户看到一堆「已复活」的噪声）。
      if (aliveRef.current) {
        if (failedNow.size > 0) setAddNames([...failedNow].join(", "));
        else setAddNames("");
        setMembersProgress(null);
      }
    } finally {
      membersPendingRef.current = false;
      if (aliveRef.current) setMembersPending(false);
    }
  }, [addAgentType, addModel, addNames, team]);

  const candidates = idleCandidateNames(workload);
  const parsedNames = useMemo(() => parseMemberNames(addNames), [addNames]);
  const nameInvalid = parsedNames.invalid.length > 0;
  // 剩余可加名额（per-team 与全局取小）：只做展示与 data 标记，判定仍以后端为准。
  const quotaRemaining = workload
    ? Math.max(0, Math.min(
      workload.quota.perTeamLimit - workload.quota.rosterWorkers,
      workload.quota.globalLimit - workload.quota.globalWorkers,
    ))
    : null;
  const memberListBusy = membersPending;
  const anyPending = pendingRows.length > 0;

  return (
    <div
      className="agent-teams-dispatch"
      data-testid="agent-teams-dispatch"
      aria-busy={loading || anyPending || membersPending}
    >
      <div className="agent-teams-dispatch-head">
        <span className="agent-teams-dispatch-title">{t("teams.dispatch.title")}</span>
        {batchTargets.length > 1 && (
          <button
            type="button"
            className="agent-teams-dispatch-refresh"
            data-testid="agent-teams-dispatch-batch"
            disabled={loading || anyPending}
            aria-expanded={batchConfirming}
            onClick={() => setBatchConfirming((current) => !current)}
          >
            {t("teams.dispatch.execute")}
            <span aria-hidden="true"> ×{batchTargets.length}</span>
          </button>
        )}
        <button
          type="button"
          className="agent-teams-dispatch-refresh"
          disabled={loading || !team}
          onClick={() => void refresh()}
        >
          {t("teams.dispatch.refresh")}
        </button>
      </div>

      {batchConfirming && batchTargets.length > 0 && (
        <div
          className="agent-teams-dispatch-confirm"
          role="group"
          aria-label={`${t("teams.dispatch.confirm")} ×${batchTargets.length}`}
          data-testid="agent-teams-dispatch-batch-confirm"
          onKeyDown={(event) => {
            // 内联确认区：Esc 只收起本次确认，stopPropagation 防它冒泡到全局
            // 「Esc 停止运行中的 agent」。
            if (event.key !== "Escape") return;
            event.stopPropagation();
            event.preventDefault();
            setBatchConfirming(false);
          }}
        >
          <span className="agent-teams-dispatch-confirm-label">{t("teams.dispatch.confirm")}</span>
          <button
            type="button"
            className="agent-teams-dispatch-execute"
            disabled={anyPending}
            onClick={() => void runBatch()}
          >
            {t("teams.dispatch.execute")}
            <span aria-hidden="true"> ×{batchTargets.length}</span>
          </button>
          <button type="button" className="agent-teams-dispatch-inline" onClick={() => setBatchConfirming(false)}>
            {t("i18n.cancel")}
          </button>
        </div>
      )}

      {!team ? null : (
        <>
          {/* 加载失败只挂错误条：保留上一份成功快照（见 refresh 的 catch 注释）。 */}
          {loadError && (
            <p className="agent-teams-dispatch-error" role="alert">
              {t("teams.dispatch.loadFailed", { error: loadError })}
            </p>
          )}
          {loading && !workload && !loadError ? (
            <p className="agent-teams-dispatch-empty">{t("i18n.loading")}</p>
          ) : suggestions.length === 0 ? (
            <p className="agent-teams-dispatch-empty">{t("teams.dispatch.empty")}</p>
          ) : (
            <ul className="agent-teams-dispatch-list" aria-busy={anyPending}>
              {suggestions.map((suggestion) => {
                const rowKey = suggestionRowKey(suggestion);
                const subject = ticketSubjects?.[suggestion.ticketId] ?? suggestion.ticketId;
                const toMember = selectedTo[rowKey] ?? suggestion.toMember ?? "";
                const result = rowResults[rowKey];
                const inFlight = pendingRows.includes(rowKey);
                const isAddMember = suggestion.kind === "add-member";
                const descKey = isAddMember
                  ? "teams.dispatch.addMemberHint"
                  : suggestion.kind === "reassign"
                    ? "teams.dispatch.reassign"
                    : "teams.dispatch.assign";
                const descParams: TranslationParams = isAddMember
                  ? {}
                  : suggestion.kind === "reassign"
                    ? { ticket: subject, from: suggestion.fromMember ?? "", member: toMember || suggestion.toMember || "" }
                    : { ticket: subject, member: toMember || suggestion.toMember || "" };
                return (
                  <li key={rowKey} className="agent-teams-dispatch-row" data-kind={suggestion.kind} data-busy={inFlight ? "true" : undefined}>
                    <div className="agent-teams-dispatch-row-main">
                      <span className="agent-teams-dispatch-desc">{t(descKey, descParams)}</span>
                      <span className="agent-teams-dispatch-reason">{t("teams.dispatch.reason", { reason: suggestion.reason })}</span>
                    </div>
                    {result && (
                      // aria-live + tabIndex=-1：异步结果既会播报，也能被程序聚焦
                      // （原来结果只是普通 span，键盘/读屏用户完全收不到派发结局）。
                      <span
                        ref={(node) => setRowNodes(rowKey, "result", node)}
                        className={`agent-teams-dispatch-result agent-teams-dispatch-result--${result.phase}`}
                        data-dispatch-result={result.phase}
                        tabIndex={-1}
                        role="status"
                        aria-live="polite"
                      >
                        {result.text}
                        {result.phase === "conflict" && (
                          <button type="button" className="agent-teams-dispatch-inline" onClick={() => { setRowResults((prev) => { const next = { ...prev }; delete next[rowKey]; return next; }); void refresh(); }}>
                            {t("teams.dispatch.refresh")}
                          </button>
                        )}
                        {result.phase === "failed" && (
                          <button
                            type="button"
                            className="agent-teams-dispatch-inline"
                            disabled={inFlight}
                            onClick={() => void execute(suggestion, toMember, result.clientRequestId)}
                          >
                            {t("teams.dispatch.retry")}
                          </button>
                        )}
                      </span>
                    )}
                    {confirming === rowKey && !isAddMember && (
                      <div
                        className="agent-teams-dispatch-confirm"
                        role="group"
                        aria-label={t("teams.dispatch.confirm")}
                        onKeyDown={(event) => {
                          if (event.key !== "Escape") return;
                          event.stopPropagation();
                          event.preventDefault();
                          setConfirming(null);
                          // 焦点还给发起「执行」的按钮，别丢到 body。
                          setFocusRequest({ key: rowKey, target: "execute", nonce: Date.now() });
                        }}
                      >
                        <span className="agent-teams-dispatch-confirm-label">{t("teams.dispatch.reassignTo")}</span>
                        <AppSelect
                          className="agent-teams-dispatch-select"
                          aria-label={t("teams.dispatch.reassignTo")}
                          value={toMember}
                          placeholder={t("teams.dispatch.reassignTo")}
                          disabled={inFlight || candidates.length === 0}
                          onValueChange={(next) => setSelectedTo((prev) => ({ ...prev, [rowKey]: next }))}
                          options={candidates.map((name) => ({ value: name, label: name }))}
                        />
                        {candidates.length === 0 && (
                          <span className="agent-teams-dispatch-confirm-note">{t("teams.dispatch.noIdle")}</span>
                        )}
                        <button
                          type="button"
                          ref={(node) => setRowNodes(rowKey, "confirm", node)}
                          className="agent-teams-dispatch-execute"
                          disabled={inFlight || !toMember}
                          onClick={() => void execute(suggestion, toMember)}
                        >
                          {inFlight ? t("teams.dispatch.inFlight") : t("teams.dispatch.confirm")}
                        </button>
                        <button
                          type="button"
                          className="agent-teams-dispatch-inline"
                          disabled={inFlight}
                          onClick={() => {
                            setConfirming(null);
                            setFocusRequest({ key: rowKey, target: "execute", nonce: Date.now() });
                          }}
                        >
                          {t("i18n.cancel")}
                        </button>
                      </div>
                    )}
                    {confirming === rowKey && isAddMember && (
                      <div className="agent-teams-dispatch-confirm agent-teams-dispatch-member-form" role="group" aria-label={t("teams.dispatch.addMember")}>
                        {workload && (
                          <span
                            className="agent-teams-dispatch-quota"
                            data-quota-remaining={quotaRemaining ?? undefined}
                          >
                            {t("teams.dispatch.quota", {
                              roster: workload.quota.rosterWorkers,
                              perTeam: workload.quota.perTeamLimit,
                              global: workload.quota.globalWorkers,
                              globalLimit: workload.quota.globalLimit,
                            })}
                          </span>
                        )}
                        <label className="agent-teams-dispatch-field">
                          <span>{t("teams.dispatch.memberName")}</span>
                          {/* 一次可填多个名字（逗号/空格/换行分隔）：后端单请求支持 1..8 个，
                              超出自动分块并发——20 个成员不再需要 20 次输入 + 20 次往返。 */}
                          <textarea
                            className="agent-teams-dispatch-input"
                            data-testid="agent-teams-dispatch-member-names"
                            rows={2}
                            style={{ minWidth: 0, resize: "vertical", fontFamily: "var(--font-mono)" }}
                            value={addNames}
                            disabled={memberListBusy}
                            onChange={(event) => setAddNames(event.target.value)}
                            placeholder="worker-two, worker-three"
                          />
                        </label>
                        {nameInvalid && (
                          <span className="agent-teams-dispatch-field-error">
                            {t("teams.dispatch.memberNameInvalid")}: {parsedNames.invalid.join(", ")}
                          </span>
                        )}
                        {parsedNames.duplicates.length > 0 && (
                          <span className="agent-teams-dispatch-confirm-note" data-duplicate-names={parsedNames.duplicates.join(",")}>
                            ×{parsedNames.duplicates.length}
                          </span>
                        )}
                        <label className="agent-teams-dispatch-field">
                          <span>{t("teams.dispatch.memberRole")}</span>
                          <input
                            className="agent-teams-dispatch-input"
                            value={addAgentType}
                            disabled={memberListBusy}
                            onChange={(event) => setAddAgentType(event.target.value)}
                            placeholder="member"
                          />
                        </label>
                        <label className="agent-teams-dispatch-field">
                          <span>{t("teams.dispatch.memberModel")}</span>
                          <input
                            className="agent-teams-dispatch-input"
                            value={addModel}
                            disabled={memberListBusy}
                            onChange={(event) => setAddModel(event.target.value)}
                          />
                        </label>
                        <button
                          type="button"
                          className="agent-teams-dispatch-execute"
                          disabled={memberListBusy || parsedNames.names.length === 0 || nameInvalid}
                          data-batch-size={parsedNames.names.length || undefined}
                          onClick={() => void submitMembers()}
                        >
                          {memberListBusy ? t("teams.dispatch.inFlight") : t("teams.dispatch.memberSubmit")}
                          {parsedNames.names.length > 1 ? <span aria-hidden="true"> ×{parsedNames.names.length}</span> : null}
                        </button>
                        <button
                          type="button"
                          className="agent-teams-dispatch-inline"
                          disabled={memberListBusy}
                          onClick={() => setConfirming(null)}
                        >
                          {t("i18n.cancel")}
                        </button>
                        {membersProgress && membersProgress.total > 1 && (
                          <span className="agent-teams-dispatch-quota" aria-hidden="true" data-members-progress={membersProgress.done}>
                            {membersProgress.done}/{membersProgress.total}
                          </span>
                        )}
                        {membersError && (
                          <span className="agent-teams-dispatch-result agent-teams-dispatch-result--failed" role="alert">
                            {membersError}
                          </span>
                        )}
                        {memberReceipts && memberReceipts.map((receipt) => {
                          const label = receipt.status === "spawned"
                            ? t("teams.dispatch.member.spawned")
                            : receipt.status === "respawned"
                              ? t("teams.dispatch.member.respawned")
                              : receipt.status === "failed"
                                ? t("teams.dispatch.member.failed")
                                : receipt.status;
                          return (
                            <span
                              key={receipt.name}
                              className={`agent-teams-dispatch-result agent-teams-dispatch-result--${receipt.status === "failed" ? "failed" : "ok"}`}
                              data-member-status={receipt.status}
                            >
                              {receipt.name}: {label}
                              {receipt.reason ? ` — ${receipt.reason}` : ""}
                              {receipt.warning ? ` (${receipt.warning})` : ""}
                            </span>
                          );
                        })}
                      </div>
                    )}
                    {!result && confirming !== rowKey && (
                      <button
                        type="button"
                        ref={(node) => setRowNodes(rowKey, "execute", node)}
                        className="agent-teams-dispatch-execute"
                        disabled={inFlight || (!isAddMember && !suggestion.toMember)}
                        onClick={() => {
                          const next = confirming === rowKey ? null : rowKey;
                          setConfirming(next);
                          // 展开确认区后，原来这个按钮会被替换掉：主动把焦点搬到
                          // 确认按钮上（否则焦点掉到 body，键盘用户直接迷路）。
                          if (next) setFocusRequest({ key: rowKey, target: "confirm", nonce: Date.now() });
                        }}
                      >
                        {inFlight ? t("teams.dispatch.inFlight") : t("teams.dispatch.execute")}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <p className="agent-teams-dispatch-running-note" data-testid="agent-teams-dispatch-running-note">
        {t("teams.dispatch.runningNote")}
      </p>
    </div>
  );
}
