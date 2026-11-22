"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useModelCatalog, type ModelCatalogEntry } from "@/hooks/useModelCatalog";
import { ModelPicker } from "./ModelPicker";

/** PATCH /api/teams/[team]/members 的逐成员回执（与 swimlane-store 的 TeamMemberModelResult 同形）。 */
export interface MemberModelResult {
  memberId: string;
  name: string | null;
  /** applied=已生效；saved=会话不在，已保存待复活；failed=失败。 */
  status: "applied" | "saved" | "failed";
  reason?: string;
}

export interface PanelMember {
  id: string;
  name: string;
}

/** 单个 PATCH 里带多少个成员：一次 60 个成员会让后端在单个请求里串行投递 60 次
 *  set_model（每次都要等会话回执），前端只能干等到超时；分块后逐块回执可见。 */
export const MEMBER_MODEL_CHUNK_SIZE = 8;
/** 分块并发上限：会话投递会抢同一条进程内注册表，2 路足够。 */
export const MEMBER_MODEL_MAX_CONCURRENCY = 2;
/** 分块之间的节流（毫秒）。 */
export const MEMBER_MODEL_GAP_MS = 80;

/** 用目录把 'provider/modelId' 解析回 { provider, modelId }，避免对含斜杠的 id 做字符串拆分。 */
export function resolveModelRef(
  entries: ModelCatalogEntry[],
  ref: string | null,
): { provider: string; modelId: string } | null {
  if (!ref) return null;
  const entry = entries.find((item) => item.ref === ref);
  return entry ? { provider: entry.provider, modelId: entry.id } : null;
}

/** 组装 PATCH 请求体；模型未定返回 null。 */
export function buildMemberModelBody(
  memberIds: string[],
  model: { provider: string; modelId: string } | null,
): { memberIds: string[]; provider: string; modelId: string } | null {
  if (!model) return null;
  return { memberIds: [...new Set(memberIds)], provider: model.provider, modelId: model.modelId };
}

/** 按分块上限切分成员 id（空数组 → 空块，不构造空请求）。 */
export function chunkMemberIds(
  memberIds: readonly string[],
  size: number = MEMBER_MODEL_CHUNK_SIZE,
): string[][] {
  const limit = Math.max(1, Math.floor(size) || 1);
  const chunks: string[][] = [];
  for (let index = 0; index < memberIds.length; index += limit) {
    chunks.push(memberIds.slice(index, index + limit));
  }
  return chunks;
}

/**
 * 有界并发扇出。
 *
 * 与 DispatchPanel 里的同名工具同源（那边导出会连带 AppSelect/radix，把这个面板的
 * 纯渲染测试也拖进缺包环境，所以这里保留一份 15 行实现）。语义一致：
 * 单块抛错被收进 failures，其余块照常跑完——绝不让 `Promise.all` 的 reject 把
 * 已经成功的回执一起吞掉。
 */
export async function runMemberModelChunks<T>(
  chunks: readonly T[],
  limit: number,
  worker: (chunk: T, index: number) => Promise<void>,
  options: { gapMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ failures: { index: number; error: unknown }[] }> {
  const failures: { index: number; error: unknown }[] = [];
  if (chunks.length === 0) return { failures };
  const lanes = Math.max(1, Math.min(Math.floor(limit) || 1, chunks.length));
  const gapMs = Math.max(0, options.gapMs ?? 0);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let cursor = 0;
  const run = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= chunks.length) return;
      if (gapMs > 0 && index > 0) await sleep(gapMs);
      try {
        await worker(chunks[index], index);
      } catch (error) {
        failures.push({ index, error });
      }
    }
  };
  await Promise.all(Array.from({ length: lanes }, run));
  return { failures };
}

export interface GroupedModelResults {
  applied: string[];
  saved: string[];
  failed: { name: string; reason: string }[];
}

/** 按回执状态分组；name 缺失回退 memberId。三态都保留，绝不合并成一句成功。 */
export function groupModelResults(results: MemberModelResult[]): GroupedModelResults {
  const applied: string[] = [];
  const saved: string[] = [];
  const failed: { name: string; reason: string }[] = [];
  for (const result of results) {
    const label = result.name ?? result.memberId;
    if (result.status === "applied") applied.push(label);
    else if (result.status === "saved") saved.push(label);
    else failed.push({ name: label, reason: result.reason ?? "" });
  }
  return { applied, saved, failed };
}

/** 逐成员回执渲染：applied / saved / failed 三态分开列出（failed 带 reason）。 */
export function MemberModelReceipts({ results }: { results: MemberModelResult[] }) {
  const { t } = useI18n();
  const grouped = useMemo(() => groupModelResults(results), [results]);
  return (
    <div
      className="team-model-receipts"
      data-testid="team-model-receipts"
      role="status"
      aria-live="polite"
      data-receipt-count={results.length}
    >
      <h5 className="team-model-receipts-title">{t("teams.memberModel.receiptTitle")}</h5>
      {grouped.applied.length > 0 && (
        <p className="team-model-receipt team-model-receipt--applied" data-status="applied" style={{ overflowWrap: "anywhere" }}>
          {t("teams.memberModel.applied")}: {grouped.applied.join("、")}
        </p>
      )}
      {grouped.saved.length > 0 && (
        <p className="team-model-receipt team-model-receipt--saved" data-status="saved" style={{ overflowWrap: "anywhere" }}>
          {t("teams.memberModel.saved")}: {grouped.saved.join("、")}
        </p>
      )}
      {grouped.failed.length > 0 && (
        <ul className="team-model-receipt team-model-receipt--failed" data-status="failed">
          {grouped.failed.map((item) => (
            <li key={item.name} style={{ overflowWrap: "anywhere" }}>
              {t("teams.memberModel.failedLine", {
                name: item.name,
                reason: item.reason || t("teams.memberModel.failedUnknown"),
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface TeamMemberModelPanelProps {
  /** 目录名（URL 用），不是 displayName。 */
  team: string;
  members: PanelMember[];
  /** 初选成员（单个=1 个；批量=多选起点）。 */
  memberIds: string[];
  mode: "single" | "batch";
  onClose: () => void;
  /** 至少一个成员成功（applied/saved）后回调，父级可借此刷新。 */
  onApplied?: () => void;
  /**
   * 会话 cwd（`/api/models?cwd=` 用）。缺它时路由退回**进程** cwd，而打包版进程 cwd
   * 是 `resources/server`（不在文件白名单里）→ 400 → 模型目录为空，选择器一个模型都没有。
   */
  cwd?: string | null;
}

/**
 * 成员改模型面板：单个（成员行「换模型」）与批量（顶部「批量换模型」）共用。
 * 复用 ModelPicker（单选），提交到 PATCH /api/teams/[team]/members，逐成员如实回执。
 *
 * 批量口径：成员多（20~60）时**分块并发**提交（MEMBER_MODEL_CHUNK_SIZE / 2 路），
 * 每块回来就把该块回执合并进结果区——用户能看见「已处理 n/总数」，而不是盯着一个
 * 转圈的按钮等 60 次会话投递排完；某块失败只标该块成员，其余块照常完成。
 */
export function TeamMemberModelPanel({
  team,
  members,
  memberIds,
  mode,
  onClose,
  onApplied,
  cwd = null,
}: TeamMemberModelPanelProps) {
  const { t } = useI18n();
  const { catalog, loading, error } = useModelCatalog(cwd);
  const panelRef = useRef<HTMLDivElement>(null);
  const receiptsRef = useRef<HTMLDivElement>(null);
  const submittingRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);
  const [ids, setIds] = useState<string[]>(memberIds);
  const [modelRef, setModelRef] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<MemberModelResult[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // 面板是成员列表之后的普通文档流块，常在折叠线以下——打开即滚到可见并把焦点
  // 落到面板（键盘可达）。否则「点了换模型却看不到面板」= 够不着。
  useEffect(() => {
    const node = panelRef.current;
    if (!node) return;
    node.scrollIntoView({ block: "nearest" });
    node.focus({ preventScroll: true });
  }, []);

  const model = resolveModelRef(catalog.entries, modelRef);
  const nameById = useMemo(() => new Map(members.map((member) => [member.id, member.name])), [members]);

  const toggleMember = (id: string) => {
    setIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const submit = async () => {
    if (ids.length === 0) { setFailure(t("teams.memberModel.needMembers")); return; }
    const body = buildMemberModelBody(ids, model);
    if (!body) { setFailure(t("teams.memberModel.needModel")); return; }
    // 在途闸用 ref：双击会在同一个 state 刷新前看到 busy=false，发出两条 PATCH。
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setFailure(null);
    setResults(null);
    setProgress({ done: 0, total: body.memberIds.length });
    const { provider, modelId } = body;
    const chunks = chunkMemberIds(body.memberIds);
    let done = 0;
    let anyApplied = false;
    let hadResults = false;
    try {
      const { failures } = await runMemberModelChunks(
        chunks,
        MEMBER_MODEL_MAX_CONCURRENCY,
        async (chunk) => {
          try {
            const response = await fetch(`/api/teams/${encodeURIComponent(team)}/members`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              // 契约不变：仍是 { memberIds, provider, modelId }，只是按块发。
              body: JSON.stringify({ memberIds: chunk, provider, modelId }),
            });
            const payload = await response.json().catch(() => null) as
              | { results?: MemberModelResult[]; error?: string }
              | null;
            if (!aliveRef.current) return;
            const list = Array.isArray(payload?.results) ? payload!.results! : [];
            if (list.length > 0) {
              hadResults = true;
              if (list.some((result) => result.status !== "failed")) anyApplied = true;
              setResults((prev) => [...(prev ?? []), ...list]);
            }
            // 服务端没回执的成员（404/400/协议异常、或部分被拒）也要如实落一条失败，
            // 否则它们会从结果区「消失」——用户会以为全都改成功了。
            const covered = new Set(list.map((result) => result.memberId));
            const missing = chunk.filter((id) => !covered.has(id));
            if (missing.length > 0) {
              hadResults = true;
              const reason = payload?.error ?? (response.ok ? "" : `HTTP ${response.status}`);
              setResults((prev) => [...(prev ?? []), ...missing.map((id) => ({
                memberId: id,
                name: nameById.get(id) ?? null,
                status: "failed" as const,
                reason,
              }))]);
              if (reason) {
                setFailure(t("teams.memberModel.requestFailed", { message: reason }));
              } else {
                setFailure(t("teams.memberModel.requestFailed", {
                  message: t("teams.memberModel.failedUnknown"),
                }));
              }
            }
          } catch (err) {
            if (!aliveRef.current) return;
            hadResults = true;
            const message = err instanceof Error ? err.message : String(err);
            setResults((prev) => [...(prev ?? []), ...chunk.map((id) => ({
              memberId: id,
              name: nameById.get(id) ?? null,
              status: "failed" as const,
              reason: message,
            }))]);
            setFailure(t("teams.memberModel.requestFailed", { message }));
          } finally {
            done += chunk.length;
            if (aliveRef.current) setProgress({ done, total: body.memberIds.length });
          }
        },
        { gapMs: MEMBER_MODEL_GAP_MS },
      );
      if (failures.length > 0 && aliveRef.current) {
        // worker 已自吞业务异常；走到这里说明是编程错误，如实报，不假装整批成功。
        setFailure(t("teams.memberModel.requestFailed", {
          message: failures
            .map((item) => (item.error instanceof Error ? item.error.message : String(item.error)))
            .join("; "),
        }));
      }
      if (anyApplied && aliveRef.current) onApplied?.();
    } finally {
      submittingRef.current = false;
      if (aliveRef.current) {
        setBusy(false);
        setProgress(null);
        // 回执落地后把焦点移到结果区：批量改 60 个成员时，结果常在折叠线以下，
        // 而原焦点所在的提交按钮刚经历一次长等待——不搬焦点，键盘用户会以为没反应。
        if (hadResults) receiptsRef.current?.focus({ preventScroll: true });
      }
    }
  };

  const title = mode === "single"
    ? t("teams.memberModel.title")
    : t("teams.memberModel.batchTitle", { count: ids.length });

  return (
    <div
      ref={panelRef}
      className="team-member-model-panel"
      role="group"
      aria-label={title}
      aria-busy={busy}
      data-mode={mode}
      tabIndex={-1}
      onKeyDown={(event) => {
        // 焦点落在面板内时 Esc 关闭（不抢全局 Esc：只有面板内部按键才触发）。
        // 提交中忽略 Esc：关掉面板会把已经发出的 PATCH 的逐成员回执一起丢掉，
        // 用户看不到谁成功谁失败（取消按钮同样在提交中禁用）。
        if (event.key === "Escape") {
          if (submittingRef.current) {
            event.stopPropagation();
            return;
          }
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <h4 className="team-member-model-title">{title}</h4>

      {mode === "batch" ? (
        <div className="team-member-model-members">
          <span className="team-member-model-members-label">
            {t("teams.memberModel.membersSelected", { count: ids.length })}
          </span>
          <ul className="team-member-model-member-list">
            {members.map((member) => {
              const on = ids.includes(member.id);
              return (
                <li key={member.id} style={{ minWidth: 0, maxWidth: "100%" }}>
                  <button
                    type="button"
                    className={`team-member-model-member${on ? " is-selected" : ""}`}
                    aria-pressed={on}
                    disabled={busy}
                    title={member.name}
                    style={{ maxWidth: "100%", overflowWrap: "anywhere" }}
                    onClick={() => toggleMember(member.id)}
                  >
                    <span className="team-member-model-check" aria-hidden="true" />
                    {member.name}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="team-member-model-single" style={{ overflowWrap: "anywhere" }}>
          {ids.map((id) => nameById.get(id) ?? id).join("、")}
        </p>
      )}

      <div className="team-member-model-picker">
        <span className="team-member-model-picker-label">{t("teams.memberModel.modelLabel")}</span>
        <ModelPicker
          catalog={catalog}
          value={modelRef ? [modelRef] : []}
          onChange={(next) => setModelRef(next[0] ?? null)}
          loading={loading}
          error={error}
          single
        />
      </div>

      {failure && <p className="team-member-model-error" role="alert">{failure}</p>}
      {progress && progress.total > 1 && (
        <span className="team-member-model-members-label" aria-hidden="true" data-progress-done={progress.done}>
          {progress.done}/{progress.total}
        </span>
      )}
      <div ref={receiptsRef} tabIndex={-1}>
        {results && results.length > 0 && <MemberModelReceipts results={results} />}
      </div>

      <div className="team-member-model-actions">
        <button type="button" className="team-member-model-submit" disabled={busy} onClick={() => void submit()}>
          {busy ? t("teams.memberModel.submitting") : t("teams.memberModel.confirm")}
        </button>
        <button type="button" className="team-member-model-cancel" disabled={busy} onClick={onClose}>
          {t("teams.memberModel.close")}
        </button>
      </div>
    </div>
  );
}
