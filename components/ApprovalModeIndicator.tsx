"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ChatConfirmDialog } from "./ChatConfirmDialog";

/**
 * 输入框底栏的「命令审批档位」紧凑指示器。
 *
 * 只读写档位（off / dangerous / all），不做任何命令判定——判定在服务端
 * `lib/tool-approval/**` 的扩展里，每次 tool_call 重读设置。前端改动只走
 * `GET/PUT /api/tool-approval`，对下一条命令生效。设置页的量产版 UI 在
 * `components/ToolApprovalSettings.tsx`，这里只是同一个接口的底栏快捷入口。
 *
 * 循环 off → dangerous → all → off。只有进入最严档 `all`（每条 shell 都确认）
 * 时先弹一次确认；`off`（全权限/全部放行）与 `dangerous` 都直接生效、不追问。
 */

export type ApprovalMode = "off" | "dangerous" | "all";

/** 循环顺序，导出便于单测与展示。 */
export const APPROVAL_MODE_ORDER: readonly ApprovalMode[] = ["off", "dangerous", "all"];

/**
 * 下一档：off → dangerous → all → off。未知档位回落到 off（默认值）。
 * 纯函数，无副作用。
 */
export function nextApprovalMode(mode: ApprovalMode): ApprovalMode {
  const index = APPROVAL_MODE_ORDER.indexOf(mode);
  if (index < 0) return "off";
  return APPROVAL_MODE_ORDER[(index + 1) % APPROVAL_MODE_ORDER.length];
}

/**
 * 切换到目标档位是否需要先确认：**只有进入 `all`（最严档，每条 shell 都确认）**
 * 需要确认。`off`（全权限/全部放行，等价 cc-haha 的 bypassPermissions）与
 * `dangerous` 都静默直接生效。纯函数，便于单测。
 */
export function approvalNeedsConfirmation(mode: ApprovalMode): boolean {
  return mode === "all";
}

interface ApprovalStatus {
  mode: ApprovalMode;
  modes: readonly ApprovalMode[];
  local: boolean;
}

/**
 * 纯展示子组件：不取数、不发请求，便于 SSR 单测。
 * 按钮可点（或 disabled 只读），旁边一个 `aria-live` 区域播报当前档位，
 * 更新失败时在同一区域展示失败文案。
 */
export function ApprovalModeIndicatorView({
  mode,
  label,
  ariaLabel,
  disabled = false,
  busy = false,
  failed = false,
  updateFailedText,
  onClick,
}: {
  mode: ApprovalMode;
  label: string;
  ariaLabel: string;
  disabled?: boolean;
  busy?: boolean;
  failed?: boolean;
  updateFailedText: string;
  onClick?: () => void;
}) {
  return (
    <span className="approval-mode-indicator">
      <button
        type="button"
        className="native-toolbar-button approval-mode-indicator-button"
        aria-label={ariaLabel}
        title={label}
        aria-busy={busy || undefined}
        disabled={disabled}
        data-approval-mode={mode}
        onClick={onClick}
      >
        {label}
      </button>
      {/* 档位变化对辅助技术可感知：播报当前档位文案。视觉上隐藏（见 native-theme.css）。 */}
      <span role="status" aria-live="polite" className="approval-mode-indicator-live">
        {label}
      </span>
      {failed && (
        <span role="alert" className="approval-mode-indicator-error">
          {updateFailedText}
        </span>
      )}
    </span>
  );
}

/** 容器：挂载取一次档位，点击循环并按需确认，PUT 失败保持原档位并提示。 */
export function ApprovalModeIndicator() {
  const { t } = useI18n();
  const [status, setStatus] = useState<ApprovalStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // 已点击、正等待确认的目标档位；null 表示没有打开的确认框。
  const [pending, setPending] = useState<ApprovalMode | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/tool-approval");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setStatus((await response.json()) as ApprovalStatus);
      setFailed(false);
    } catch {
      // 取不到档位就不知道 local 是否允许改动，降级为只读并给出失败提示。
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback(async (mode: ApprovalMode) => {
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
      // 不乐观更新：失败时显示仍是原档位，失败文案由 aria-live 播报。
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);

  const local = status?.local !== false;
  const disabled = busy || !local || !status;

  const handleClick = () => {
    if (disabled || !status) return;
    const target = nextApprovalMode(status.mode);
    if (approvalNeedsConfirmation(target)) {
      setPending(target);
    } else {
      void apply(target);
    }
  };

  const handleConfirm = () => {
    if (pending === null) return;
    const target = pending;
    setPending(null);
    void apply(target);
  };

  // 静态字面量键（lib/i18n/usage.test.mjs 只校验可静态验证的键）。
  const label = status
    ? status.mode === "off"
      ? t("approval.mode.off")
      : status.mode === "dangerous"
        ? t("approval.mode.dangerous")
        : t("approval.mode.all")
    : t("approval.loading");

  // 只有进入 all 会走到确认框（见 approvalNeedsConfirmation），正文固定用 all 的状态说明。
  const dialogBody = pending === null ? null : t("approval.status.all");

  return (
    <>
      <ApprovalModeIndicatorView
        mode={status?.mode ?? "off"}
        label={label}
        ariaLabel={t("approval.cycleAria")}
        disabled={disabled}
        busy={busy}
        failed={failed}
        updateFailedText={t("approval.updateFailed")}
        onClick={handleClick}
      />
      {pending !== null && dialogBody !== null && (
        <ChatConfirmDialog
          title={t("approval.mode")}
          body={dialogBody}
          confirmLabel={t("common.ok")}
          cancelLabel={t("i18n.cancel")}
          danger
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={handleConfirm}
        />
      )}
    </>
  );
}
