"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AppSelect } from "./AppSelect";

/**
 * Settings › General › Command approval —— agent 执行 shell 命令前的确认开关
 * （对齐 alma.now 的「批准命令」）。
 *
 * 真源在服务端（`lib/tool-approval/settings.ts`），扩展每次 tool_call 都重读，
 * 所以改完对下一次调用立即生效、无需重开会话。这里只走接口，不引 lib 的策略实现
 * （它依赖 node 侧设置读写，不能进客户端 bundle）。
 *
 * 危险规则说明在界面上逐条列出：用户要能知道「仅危险命令」会拦什么，否则这个档位
 * 就是一个黑盒。规则清单与 lib/tool-approval/policy.ts 的 DANGEROUS_RULES 一一对应；
 * 键是静态字面量，lib/i18n/usage.test.mjs 会守住三语缺键。
 */

type ApprovalMode = "off" | "dangerous" | "all";

interface ApprovalStatus {
  mode: ApprovalMode;
  modes: readonly ApprovalMode[];
  local: boolean;
}

export function ToolApprovalSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<ApprovalStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/tool-approval");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setStatus((await response.json()) as ApprovalStatus);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (mode: ApprovalMode) => {
    setBusy(true);
    try {
      const response = await fetch("/api/tool-approval", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setStatus((await response.json()) as ApprovalStatus);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const local = status?.local !== false;
  const disabled = busy || !local || !status;

  const options = [
    { value: "off", label: t("approval.mode.off") },
    { value: "dangerous", label: t("approval.mode.dangerous") },
    { value: "all", label: t("approval.mode.all") },
  ];

  const statusText = (() => {
    if (!status) return t("approval.loading");
    if (status.mode === "off") return t("approval.status.off");
    if (status.mode === "dangerous") return t("approval.status.dangerous");
    return t("approval.status.all");
  })();

  const rules = [
    t("approval.rule.rm-recursive-force"),
    t("approval.rule.remove-item-recursive-force"),
    t("approval.rule.git-push-force"),
    t("approval.rule.git-reset-hard"),
    t("approval.rule.drop-table"),
    t("approval.rule.truncate-table"),
    t("approval.rule.mkfs"),
    t("approval.rule.dd-if"),
    t("approval.rule.curl-pipe-shell"),
    t("approval.rule.wget-pipe-shell"),
    t("approval.rule.chmod-recursive-777"),
    t("approval.rule.power"),
    t("approval.rule.diskpart"),
    t("approval.rule.format-volume"),
    t("approval.rule.taskkill-force"),
  ];

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("approval.title")}</h3>
      <p className="settings-general-description">{t("approval.hint")}</p>
      <div className="settings-option-list">
        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("approval.mode")}</span>
            <span className="settings-option-hint" role="status">
              {failed ? t("approval.saveFailed") : statusText}
            </span>
            {!local && <span className="settings-option-hint">{t("approval.localOnly")}</span>}
          </span>
          <AppSelect
            aria-label={t("approval.mode")}
            value={status?.mode ?? "off"}
            onValueChange={(next) => void save(next as ApprovalMode)}
            options={options}
            disabled={disabled}
          />
        </div>

        {status?.mode === "dangerous" && (
          <div className="settings-option">
            <span className="settings-option-text">
              <span className="settings-option-title">{t("approval.rulesTitle")}</span>
              <span className="settings-option-hint">{t("approval.rulesHint")}</span>
              <ul className="settings-option-hint" style={{ margin: 0, paddingLeft: 18 }}>
                {rules.map((rule) => <li key={rule}>{rule}</li>)}
              </ul>
            </span>
          </div>
        )}

        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-hint">{t("approval.waitingHint")}</span>
            <span className="settings-option-hint">{t("approval.unattendedHint")}</span>
            <span className="settings-option-hint">{t("approval.appliesNextCall")}</span>
          </span>
        </div>
      </div>
    </section>
  );
}