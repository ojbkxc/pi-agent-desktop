"use client";

import { useMemo, useState } from "react";
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
    <div className="team-model-receipts" data-testid="team-model-receipts">
      <h5 className="team-model-receipts-title">{t("teams.memberModel.receiptTitle")}</h5>
      {grouped.applied.length > 0 && (
        <p className="team-model-receipt team-model-receipt--applied" data-status="applied">
          {t("teams.memberModel.applied")}: {grouped.applied.join("、")}
        </p>
      )}
      {grouped.saved.length > 0 && (
        <p className="team-model-receipt team-model-receipt--saved" data-status="saved">
          {t("teams.memberModel.saved")}: {grouped.saved.join("、")}
        </p>
      )}
      {grouped.failed.length > 0 && (
        <ul className="team-model-receipt team-model-receipt--failed" data-status="failed">
          {grouped.failed.map((item) => (
            <li key={item.name}>
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
}

/**
 * 成员改模型面板：单个（成员行「换模型」）与批量（顶部「批量换模型」）共用。
 * 复用 ModelPicker（单选），提交到 PATCH /api/teams/[team]/members，逐成员如实回执。
 */
export function TeamMemberModelPanel({
  team,
  members,
  memberIds,
  mode,
  onClose,
  onApplied,
}: TeamMemberModelPanelProps) {
  const { t } = useI18n();
  const { catalog, loading, error } = useModelCatalog();
  const [ids, setIds] = useState<string[]>(memberIds);
  const [modelRef, setModelRef] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<MemberModelResult[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const model = resolveModelRef(catalog.entries, modelRef);
  const nameById = useMemo(() => new Map(members.map((member) => [member.id, member.name])), [members]);

  const toggleMember = (id: string) => {
    setIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const submit = async () => {
    if (ids.length === 0) { setFailure(t("teams.memberModel.needMembers")); return; }
    const body = buildMemberModelBody(ids, model);
    if (!body) { setFailure(t("teams.memberModel.needModel")); return; }
    setBusy(true);
    setFailure(null);
    setResults(null);
    try {
      const response = await fetch(`/api/teams/${encodeURIComponent(team)}/members`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { results?: MemberModelResult[] };
      const list = Array.isArray(payload.results) ? payload.results : [];
      setResults(list);
      if (list.some((result) => result.status !== "failed")) onApplied?.();
    } catch (err) {
      setFailure(t("teams.memberModel.requestFailed", {
        message: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusy(false);
    }
  };

  const title = mode === "single"
    ? t("teams.memberModel.title")
    : t("teams.memberModel.batchTitle", { count: ids.length });

  return (
    <div className="team-member-model-panel" role="group" aria-label={title} data-mode={mode}>
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
                <li key={member.id}>
                  <button
                    type="button"
                    className={`team-member-model-member${on ? " is-selected" : ""}`}
                    aria-pressed={on}
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
        <p className="team-member-model-single">
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
      {results && <MemberModelReceipts results={results} />}

      <div className="team-member-model-actions">
        <button type="button" className="team-member-model-submit" disabled={busy} onClick={() => void submit()}>
          {busy ? t("teams.memberModel.submitting") : t("teams.memberModel.confirm")}
        </button>
        <button type="button" className="team-member-model-cancel" onClick={onClose}>
          {t("teams.memberModel.close")}
        </button>
      </div>
    </div>
  );
}
