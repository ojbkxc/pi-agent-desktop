"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TeamPlanView } from "@/lib/agent-teams-plan";

/**
 * B3 计划卡的数据源：按团队名拉 `/api/teams/[team]/plan` 并每 2 秒轮询（对齐 cc-haha
 * AgentTeamsPlanCard 的 2s 刷新）。页面不可见时暂停，切回前台立即补一次。
 *
 * approve 也在这里：POST `/api/teams/[team]/plan/approve`（只投递 prompt 给 lead，不写盘）。
 * 成功后就地 refresh，等 lead 把计划推进到 launching 后卡片自然消失。
 *
 * 与轮询/写操作的三条竞态纪律（都是用户实际踩到的 bug）：
 * 1. **写优先**：PATCH / approve 在途时本轮轮询直接让路（写还没落盘，读回来的是旧
 *    revision；套用回去会把刚保存的计划/草稿基线拽回去，用户看到按钮闪、保存 409）。
 * 2. **请求序号 + abort**：`refreshKey`/`tick` 重跑 effect 后，旧请求晚到的响应一律丢弃，
 *    并把旧连接断掉（半开连接不该继续占着 2s 的节奏）。
 * 3. **卸载后不 setState**：所有落地分支先看挂载位。
 *
 * 不 import 任何含 node:fs 的模块：只依赖纯类型。
 */

/** 计划卡轮询节奏（与 cc-haha 一致：2s）。 */
export const TEAM_PLAN_POLL_MS = 2000;
/** 单次拉取的超时（超时按失败处理，可重试；必须大于轮询间隔以免半开连接永久挂起）。 */
export const TEAM_PLAN_FETCH_TIMEOUT_MS = 8000;
/**
 * 写操作（PATCH / approve POST）的超时。挂死的写请求会把 `busy`/`saving` 永远钉在 true 上
 * ——按钮一直灰着、后续轮询一直让路，界面等于卡死。超时按失败处理，让用户能重试。
 */
export const TEAM_PLAN_MUTATION_TIMEOUT_MS = 15000;
/**
 * 一次「读空」之后的确认间隔。写盘是「临时文件 + rename」，Windows 上另有极小的
 * 读空/读旧窗口；一次 null 就让卡片消失会看到「闪一下」。空响应连续两次才认。
 */
export const TEAM_PLAN_NULL_CONFIRM_MS = 250;

export interface UseTeamPlanResult {
  plan: TeamPlanView | null;
  /** 拉取失败信息（网络/500）；成功或「无计划」时为 null。 */
  error: string | null;
  /**
   * 批准流程进行中（含 `saveAndApprove` 先保存 PATCH 的那一段）。卡片的批准按钮据此禁用：
   * 只要有一个写操作在途，就不该再让用户点。
   */
  busy: boolean;
  /** 上次批准失败的原因（投递失败 / identity 409 / 状态不允许 / 门禁 403）；成功或重试后清空。 */
  approveError: string | null;
  /** 保存编辑进行中（只覆盖 PATCH 本身）。 */
  saving: boolean;
  /** 保存失败信息。 */
  saveError: string | null;
  /** 上次保存/批准因乐观并发冲突（409）失败：界面提示重新载入。 */
  conflict: boolean;
  /** 主动补拉一次。 */
  refresh(): void;
  /** 批准当前计划（投递给 lead）。返回是否投递成功。 */
  approve(): Promise<{ ok: boolean; reason?: string }>;
  /**
   * 批准并先落地编辑：有改动时先 PATCH（revision+1），再用**保存后的** revision 投递批准。
   * 编辑为空时等价于 `approve()`。保存或投递失败都返回 ok=false，错误留在 saveError /
   * conflict / approveError 上。
   */
  saveAndApprove(edits: PlanEdits | null): Promise<{ ok: boolean; reason?: string }>;
  /** 保存编辑（PATCH）。成功后就地回填 plan（revision 已 +1）。 */
  /** 批准指令是否已送达 lead（弹框据此立刻收起，见 `delivered` 的注释）。 */
  delivered: { planId: string; revision: number } | null;
  save(edits: PlanEdits): Promise<{ ok: boolean; reason?: string; plan?: TeamPlanView }>;
}

export interface PlanMemberEditDraft {
  id: string;
  agentType?: string;
  runtime?: { providerId: string; modelId: string; effortLevel?: string };
}

export interface PlanTaskEditDraft {
  id: string;
  ownerId?: string;
}

export interface PlanEdits {
  members: PlanMemberEditDraft[];
  tasks: PlanTaskEditDraft[];
}

/**
 * 轮询响应是否该覆盖当前 plan（并**是否该换掉对象身份**）。
 *
 * 两件事都靠它：
 *
 * 1. **陈旧响应**：2s 轮询与 PATCH 保存会并发，一个早于写入发出的响应可能后到并把 plan 退回
 *    旧 revision —— 那会连带把编辑器的草稿基线重置，用户刚改的、没保存的内容会消失。
 *    同一世系（planId + incarnationId）里 revision 只增不减，所以更小的 revision 一律忽略。
 * 2. **对象身份**：`PlanEditor` 以 `plan` 为依赖重置草稿，而轮询每 2s 都重新解析一份 JSON
 *    （内容一样也是**新对象**）。若照单全收，用户正在编辑的草稿每 2 秒被清一次。plan.json 的
 *    任何写入（pi-team 的 `mutateTeamPlan` / `stageMember` / `approve` / 本仓的 PATCH）都会
 *    bump `revision`，所以「同世系且 revision 相同 ⇒ 内容相同」，此时必须返回**原来那个对象**，
 *    让 React 的依赖比较（Object.is）把它判成没变。
 */
export function acceptPlan(
  current: TeamPlanView | null,
  incoming: TeamPlanView | null,
): TeamPlanView | null {
  if (!incoming) return null;
  if (!current) return incoming;
  const sameLineage =
    current.planId === incoming.planId && current.incarnationId === incoming.incarnationId;
  if (sameLineage && incoming.revision <= current.revision) return current;
  return incoming;
}

/**
 * 一次请求的 signal：调用方的 abort（effect 重跑 / 卸载）+ 超时合成一个。
 *
 * `local` 为 null 表示这次请求没有「外部取消」来源（写操作就不取消，写出去就得等它回来）。
 * 测试替身把 `AbortSignal.timeout` 打桩成返回 undefined（真定时器会拖住 node 退出），
 * 所以这里必须容忍「没有超时信号」；`AbortSignal.any` 在旧环境缺失时退化成只用超时信号，
 * 总比不挂超时好（挂死比丢一次 abort 严重）。
 */
function requestSignal(local: AbortSignal | null, timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal.timeout !== "function") return local ?? undefined;
  const timeout = AbortSignal.timeout(timeoutMs) as AbortSignal | undefined;
  if (!timeout) return local ?? undefined;
  if (!local) return timeout;
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  return typeof anyFn === "function" ? anyFn([local, timeout]) : timeout;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const isTimeout = (err: unknown): boolean =>
  err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

export function useTeamPlan(teamName: string | null, refreshKey: number = 0): UseTeamPlanResult {
  const [plan, setPlan] = useState<TeamPlanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // 轮询外触发的一次性补拉计数。
  const [tick, setTick] = useState(0);
  /**
   * 批准指令**已送达 lead** 的信号。
   *
   * 为什么需要它（审批弹框「批准后很久才关」的根因）：弹框的自动关闭只看
   * `isPlanCardVisible(plan)`，而 `plan` 来自 2 秒轮询；`state` 从 `review_pending`
   * 走到 `launching` 只能由 **lead 自己被唤醒后调 `team_plan approve`** 写入。
   * 也就是说「点批准 → 弹框关」中间隔着一整个模型回合（几十秒）。
   *
   * 送达即发这个信号，界面就能立刻收起弹框（用户意图已交付），后台继续用轮询确认真实
   * 流转；失败仍然通过 `approveError` 可见（卡片会重新出现）。
   */
  const [delivered, setDelivered] = useState<{ planId: string; revision: number } | null>(null);

  /**
   * 异步分支只读 ref、不读 state/参数：真实 React 里这只关乎闭包新鲜度，但在 hooks 测试替身
   * （`hooks/__fixtures__/fake-react.mjs`）里 `useCallback` 不随 deps 重建，读 state 会永久
   * 停在首渲染的值。ref 在两个世界里都是同一个对象，行为一致。
   */
  const planRef = useRef<TeamPlanView | null>(null);
  planRef.current = plan;
  const teamNameRef = useRef<string | null>(teamName);
  teamNameRef.current = teamName;
  // 界面当前装载的是哪个团队（只在「换团队清空」effect 里更新）。与 teamNameRef 分开：
  // 那个在渲染期就变成新值，用它判断「换了团队」永远为假。
  const stateTeamRef = useRef<string | null>(teamName);
  // 还在挂载中？卸载后不再 setState。
  const mountedRef = useRef(true);
  // 在途的写操作（"save" / "approve"）：轮询据此让路，重复点击据此拦下。
  const mutationRef = useRef<"save" | "approve" | null>(null);
  // 轮询请求序号：晚到的旧响应必须丢弃。
  const pollSeqRef = useRef(0);
  // 连续「读空」次数（见 TEAM_PLAN_NULL_CONFIRM_MS）。
  const nullStreakRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** 当前团队名（闭包里的 teamName 可能是旧渲染的，统一走 ref）。 */
  const teamNameOf = (fallback: string): string => teamNameRef.current ?? fallback;

  /**
   * 落一份新计划，并清掉**已经失去意义**的写错误。
   *
   * 两条清理口径都不能更宽：
   * - 世系变化（新 planId / 新 incarnation / 计划消失）：上一条计划的失败提示不该挂在新计划上；
   * - 计划离开 review_pending（launching/running/…）：既然已经不在评审态，保存/批准错误
   *   无从修复，留着只会让用户以为卡住了。
   * 同一世系的 revision 变化**不清**：PATCH/approve 409 之后紧接着的补拉正好会带来新
   * revision，那时清掉就等于把冲突原因静默吞掉。
   */
  const acceptFromServer = useCallback((incoming: TeamPlanView | null): void => {
    if (!mountedRef.current) return;
    const current = planRef.current;
    const accepted = acceptPlan(current, incoming);
    // 引用没变（同世系同 revision）：连 setState 都不用，PlanEditor 的草稿基线完全不动。
    if (accepted !== current) {
      planRef.current = accepted;
      setPlan(accepted);
    }
    const lineageChanged = current === null || accepted === null
      ? current !== accepted
      : current.planId !== accepted.planId || current.incarnationId !== accepted.incarnationId;
    const leftReview =
      current !== null && current.state === "review_pending" && accepted !== null
      && accepted.state !== "review_pending";
    if (!lineageChanged && !leftReview) return;
    setSaveError(null);
    setConflict(false);
    setApproveError(null);
  }, []);

  // 换团队才清空上一条，避免把 A 团队的计划串到 B；同时清掉保存/批准/冲突错误，
  // 否则 A 团队的失败会挂到 B 团队的界面上。
  // **不与下面重拉 effect 合并**：tick / refreshKey 只是补拉，刷新期间必须保留旧 plan，
  // 直到新响应经 acceptPlan 接纳——否则每 2s 轮询都会把卡片闪空一次。
  //
  // 这里比对的是 `stateTeamRef`（「界面上现在显示的是哪个团队」），不是 `teamNameRef`
  // （渲染期就更新成新值，用它比会永远相等 → 这个效果一次都不会生效，A 团队的
  // plan/错误会留在 B 团队上）。
  useEffect(() => {
    if (stateTeamRef.current === teamName) return;
    stateTeamRef.current = teamName;
    planRef.current = null;
    nullStreakRef.current = 0;
    setPlan(null);
    setError(null);
    setSaveError(null);
    setConflict(false);
    setApproveError(null);
  }, [teamName]);

  useEffect(() => {
    if (!teamName) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const url = `/api/teams/${encodeURIComponent(teamName)}/plan`;
    const doc = typeof document === "undefined" ? null : document;

    const schedule = (delay: number): void => {
      if (stopped) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { void load(); }, delay);
    };

    async function load(): Promise<void> {
      if (stopped) return;
      // 写操作在途：本轮读到的必然还是写之前的 plan（revision 更小），让路即可。
      // 写操作结束后自己会触发一次补拉（sendApproval / persistEdits 的 setTick），
      // 所以这里丢一轮不会让界面停更。
      if (mutationRef.current) {
        schedule(TEAM_PLAN_POLL_MS);
        return;
      }
      if (doc && doc.visibilityState !== "visible") return; // 不可见：暂停
      const seq = ++pollSeqRef.current;
      // 上一轮还挂着（effect 因 tick/refreshKey 重跑前发出的）就断掉：不 abort 的话两条
      // 请求会抢着落地，谁后到谁说话，旧数据就可能覆盖新数据。
      controller?.abort();
      const local = new AbortController();
      controller = local;
      /** 这条响应还有资格落地吗？（effect 已停 / 有更新的请求 / 已卸载） */
      const isCurrent = (): boolean =>
        !stopped && seq === pollSeqRef.current && mountedRef.current;
      try {
        // 超时按失败处理：半开/挂死的连接不能把轮询永久卡住，AbortError 走下面的 catch
        // 落 error 并按 TEAM_PLAN_POLL_MS 重排。
        const response = await fetch(url, {
          cache: "no-store",
          signal: requestSignal(local.signal, TEAM_PLAN_FETCH_TIMEOUT_MS),
        });
        if (!isCurrent()) return;
        if (!response.ok) {
          setError(`计划读取失败（HTTP ${response.status}）`);
          schedule(TEAM_PLAN_POLL_MS);
          return;
        }
        const data = (await response.json()) as { plan: TeamPlanView | null };
        if (!isCurrent()) return;
        if (data.plan === null && planRef.current) {
          // 有旧计划却读到空：可能是写盘的瞬时窗口，也可能是计划真被删了。再确认一次。
          nullStreakRef.current += 1;
          if (nullStreakRef.current < 2) {
            setError(null);
            schedule(TEAM_PLAN_NULL_CONFIRM_MS);
            return;
          }
        } else {
          nullStreakRef.current = 0;
        }
        acceptFromServer(data.plan);
        setError(null);
        schedule(TEAM_PLAN_POLL_MS);
      } catch (err) {
        // 被我们自己 abort 掉的旧请求不算错误（seq 已过期），别把 AbortError 显示给用户。
        if (!isCurrent()) return;
        setError(errorMessage(err));
        schedule(TEAM_PLAN_POLL_MS);
      }
    }

    const onVisibilityChange = (): void => {
      if (doc && doc.visibilityState === "visible") schedule(0);
    };

    doc?.addEventListener("visibilitychange", onVisibilityChange);
    void load();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      controller?.abort();
      doc?.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [teamName, refreshKey, tick, acceptFromServer]);

  const refresh = useCallback(() => {
    if (mountedRef.current) setTick((value) => value + 1);
  }, []);

  /** 投递批准的公共部分：调用方保证 base 是磁盘上的当前计划（保存后用它更新过的版本）。 */
  const sendApproval = useCallback(
    async (base: TeamPlanView): Promise<{ ok: boolean; reason?: string }> => {
      if (mountedRef.current) {
        setBusy(true);
        setApproveError(null);
      }
      try {
        const response = await fetch(
          `/api/teams/${encodeURIComponent(teamNameOf(base.teamName))}/plan/approve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: requestSignal(null, TEAM_PLAN_MUTATION_TIMEOUT_MS),
            body: JSON.stringify({
              planId: base.planId,
              sessionId: base.sessionId,
              incarnationId: base.incarnationId,
              expectedRevision: base.revision,
            }),
          },
        );
        const data = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          reason?: string;
          error?: string;
        };
        if (mountedRef.current) {
          // 无论成败都补拉一次：成功要看 launching，失败也要看磁盘上的真实状态（可能是
          // 别人改了 revision，或者 lead 已经自己批过了）。
          setTick((value) => value + 1);
        }
        if (!response.ok || !data.ok) {
          // 门禁类错误（403/415）回的是 `error` 字段，业务失败回 `reason`——两条都取，
          // 否则界面只显示一句「批准失败（HTTP 403）」，用户根本不知道原因。
          const reason = data.reason ?? data.error ?? `批准失败（HTTP ${response.status}）`;
          if (mountedRef.current) {
            setApproveError(reason);
            // 409 = 计划已变（revision / incarnation / state）。置 conflict 让编辑器出现
            // 「重新载入」入口；否则用户只会反复点批准、每次都被 409 打回，而草稿基线
            // 一直是旧的。
            if (response.status === 409) setConflict(true);
          }
          return { ok: false, reason };
        }
        if (mountedRef.current) {
          setConflict(false);
          // 送达即发信号：弹框立刻收起，不必等 lead 跑完一轮 + 下一拍轮询。
          setDelivered({ planId: base.planId, revision: base.revision });
          // 服务端顺带回了投递后读到的快照：直接用，省掉「等下一轮 2s 轮询」那一拍。
          const after = (data as { plan?: TeamPlanView | null }).plan;
          if (after) acceptFromServer(after);
        }
        return { ok: true };
      } catch (err) {
        // 超时也要落到可见错误上：投递可能已经到达 lead，刷新后以计划状态为准。
        const reason = isTimeout(err)
          ? `批准投递超时（${TEAM_PLAN_MUTATION_TIMEOUT_MS / 1000}s）：请稍后刷新确认计划是否已开始派发`
          : errorMessage(err);
        if (mountedRef.current) {
          setApproveError(reason);
          setTick((value) => value + 1);
        }
        return { ok: false, reason };
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    // 依赖为空是刻意的：body 只读调用方传入的 base 快照，补拉走 setTick，落地走
    // mountedRef；带 acceptFromServer 只会让这个回调每次重建（lint 也判为多余依赖）。
    [],
  );

  /** 保存编辑（PATCH）。失败信息落到 saveError / conflict，不碰 approveError。 */
  const persistEdits = useCallback(
    async (
      base: TeamPlanView,
      edits: PlanEdits,
    ): Promise<{ ok: boolean; reason?: string; plan?: TeamPlanView }> => {
      if (mountedRef.current) {
        setSaving(true);
        setSaveError(null);
        setConflict(false);
      }
      try {
        const response = await fetch(
          `/api/teams/${encodeURIComponent(teamNameOf(base.teamName))}/plan`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            signal: requestSignal(null, TEAM_PLAN_MUTATION_TIMEOUT_MS),
            body: JSON.stringify({
              planId: base.planId,
              sessionId: base.sessionId,
              incarnationId: base.incarnationId,
              expectedRevision: base.revision,
              members: edits.members,
              tasks: edits.tasks,
            }),
          },
        );
        const data = (await response.json().catch(() => ({}))) as {
          plan?: TeamPlanView;
          error?: string;
        };
        if (response.status === 409) {
          const reason = data.error ?? "计划已变更，请重新载入后再保存";
          if (mountedRef.current) {
            // 冲突是「我的基线过期了」：置 conflict 给界面「重新载入」，并立刻补拉，
            // 让用户拿到新 revision 后能再保存一次。
            setConflict(true);
            setSaveError(reason);
            setTick((value) => value + 1);
          }
          return { ok: false, reason };
        }
        if (!response.ok || !data.plan) {
          const reason = data.error ?? `保存失败（HTTP ${response.status}）`;
          if (mountedRef.current) setSaveError(reason);
          return { ok: false, reason };
        }
        // 就地回填：revision 已 +1，编辑基线随 plan prop 一起重置（acceptPlan 里同世系
        // 更高 revision 照收）。没有实质改动时服务端会原样返回旧 revision，这里也不会
        // 触发无谓的重渲染。
        const saved = data.plan;
        acceptFromServer(saved);
        return { ok: true, plan: saved };
      } catch (err) {
        // PATCH 超时是「可能已写入」：必须让用户重新载入确认，而不是直接重试（重试会 409）。
        const reason = isTimeout(err)
          ? `保存超时（${TEAM_PLAN_MUTATION_TIMEOUT_MS / 1000}s）：写入可能已生效，请点「重新载入」确认后再批准`
          : errorMessage(err);
        if (mountedRef.current) {
          setSaveError(reason);
          if (isTimeout(err)) setConflict(true);
        }
        return { ok: false, reason };
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    },
    [acceptFromServer],
  );

  const approve = useCallback(async (): Promise<{ ok: boolean; reason?: string }> => {
    const current = planRef.current;
    if (!current) return { ok: false, reason: "no plan" };
    if (mutationRef.current) {
      // 上一笔写还没回来（连点）：不重复投递，避免 lead 收到两条批准指令、重复 spawn。
      return { ok: false, reason: "上一次批准还在进行中，请稍候" };
    }
    mutationRef.current = "approve";
    try {
      return await sendApproval(current);
    } finally {
      mutationRef.current = null;
    }
  }, [sendApproval]);

  const save = useCallback(
    async (edits: PlanEdits): Promise<{ ok: boolean; reason?: string; plan?: TeamPlanView }> => {
      const current = planRef.current;
      if (!current) return { ok: false, reason: "no plan" };
      if (mutationRef.current) return { ok: false, reason: "上一次保存还在进行中，请稍候" };
      mutationRef.current = "save";
      try {
        return await persistEdits(current, edits);
      } finally {
        mutationRef.current = null;
      }
    },
    [persistEdits],
  );

  const saveAndApprove = useCallback(
    async (edits: PlanEdits | null): Promise<{ ok: boolean; reason?: string }> => {
      const current = planRef.current;
      if (!current) return { ok: false, reason: "no plan" };
      if (mutationRef.current) return { ok: false, reason: "上一次保存/批准还在进行中，请稍候" };
      const hasEdits = Boolean(edits && (edits.members.length > 0 || edits.tasks.length > 0));
      if (!hasEdits) return approve();

      mutationRef.current = "approve";
      // 整段流程（PATCH + 投递）都算「批准中」：只看 busy 的批准按钮在两段之间会闪回可用，
      // 用户在下一次 2s 轮询前再点一次就会打出第二个批准。
      if (mountedRef.current) setBusy(true);
      try {
        const saved = await persistEdits(current, edits as PlanEdits);
        if (!saved.ok) {
          // 保存失败**不投递**。原因已经在 saveError / conflict 上（PATCH 409 已置
          // conflict=true），但用户点的是「批准」：编辑器那块可能被滚出视野，所以批准区
          // 也留一条短的，否则按钮点下去像没反应。
          if (mountedRef.current) {
            setApproveError(`批准没有发出：${saved.reason ?? "保存失败"}`);
          }
          return { ok: false, reason: saved.reason };
        }
        // 保存会 bump revision；批准必须用保存后的 identity，否则必然 409。
        // 服务端判定「无实质改动」时不会 bump，saved.plan 就是原 revision，同样正确。
        const base = saved.plan ?? planRef.current ?? current;
        return await sendApproval(base);
      } finally {
        if (mountedRef.current) setBusy(false);
        mutationRef.current = null;
      }
    },
    [approve, persistEdits, sendApproval],
  );

  return { plan, error, busy, approveError, saving, saveError, conflict, refresh, approve, save, saveAndApprove, delivered };
}
