"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { KeepaliveStatus } from "@/lib/keepalive/types";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";
import { formatDurationHuman } from "@/lib/format-units";

/**
 * Settings › General › 挂机保活。
 *
 * 只走接口，不 import `@/lib/keepalive/*` 的运行时代码（那些模块依赖 node:fs；
 * 只有类型是纯声明可以进来）。状态来自 `GET /api/keepalive`：
 * - 服务：当前进程 pid / uptime / 心跳年龄（keeper 每 15s 写）。
 * - 定时守护：`scripts/pi-supervisor.mjs install` 注册的 OS 计划（Windows 计划任务 /
 *   launchd / systemd user timer）最近一次巡检与重启次数。
 * - 待接续：autofix 任务里「活跃但主人已死」的孤儿数（驱动由 autofix 自己的循环负责）。
 * - 上次中断：重启时仍在跑的会话（只提示，不自动重跑普通会话）。
 *
 * 「立即检查」/「安装定时守护」把动作转给脚本执行（本机限定 + POST），打包版没有
 * 脚本时显示手工命令的替代提示。
 */

type KeepaliveAction = "check" | "start" | "install" | "uninstall";

interface ActionOutcome {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

const POLL_MS = 5000;

function formatDuration(ms: number | null): string | null {
  return formatDurationHuman(ms);
}

export function KeepaliveSection() {
  const { t } = useI18n();
  const [status, setStatus] = useState<KeepaliveStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<KeepaliveAction | null>(null);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/keepalive", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as KeepaliveStatus;
      if (!mounted.current) return;
      setStatus(data);
      setFailed(false);
    } catch {
      if (mounted.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const save = async (enabled: boolean) => {
    setBusy(true);
    try {
      const response = await fetch("/api/keepalive", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setStatus((await response.json()) as KeepaliveStatus);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (action: KeepaliveAction) => {
    setActionBusy(action);
    setOutcome(null);
    try {
      const response = await fetch("/api/keepalive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; exitCode?: number | null; output?: string; error?: string }
        | null;
      if (!response.ok && response.status !== 200) {
        setOutcome({ ok: false, exitCode: null, output: data?.error ?? `HTTP ${response.status}` });
      } else {
        setOutcome({ ok: data?.ok === true, exitCode: data?.exitCode ?? null, output: data?.output ?? "" });
      }
      await load();
    } catch {
      setOutcome({ ok: false, exitCode: null, output: t("settings.keepaliveFailed") });
    } finally {
      setActionBusy(null);
    }
  };

  const enabled = status?.enabled === true;
  // 形状守卫：接口可能回 `{}`（未登记路由 / 旧版服务 / 畸形响应的测试桩），
  // 只防 status 为 null 不够——status.server 缺席时 `status?.server.x` 会抛
  // TypeError 并炸掉整个 Settings 面板（e2e settings-controls 踩过）。
  const server = status?.server;
  const heartbeatAge = formatDuration(server?.heartbeatAgeMs ?? null);
  const uptime = formatDuration(server?.uptimeMs ?? null);
  const supervisor = status?.supervisor;
  const installed = supervisor?.record?.installed === true;
  const supervisorTarget = supervisor?.record?.installTarget ?? null;
  const restarts = supervisor?.record?.restarts ?? 0;
  const lastCheck = supervisor?.record?.lastCheckAt ?? null;
  const autofix = status?.autofix ?? null;
  const interrupted = status?.interrupted?.sessionIds?.length ?? 0;
  const resumeCount = status?.resume?.resumed?.length ?? 0;
  const resumeAt = status?.resume?.lastAt ?? null;

  const statusHint = (() => {
    if (!status) return t("settings.keepaliveLoading");
    if (failed) return t("settings.keepaliveFailed");
    return enabled ? t("settings.keepaliveOn") : t("settings.keepaliveOff");
  })();

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("settings.keepalive")}</h3>
      <p className="settings-general-description">{t("settings.keepaliveHint")}</p>

      <div className="settings-option-list">
        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("settings.keepaliveEnable")}</span>
            <span className="settings-option-hint" role="status">{statusHint}</span>
            {supervisor?.stopped && (
              <span className="settings-option-hint">{t("settings.keepaliveStopped")}</span>
            )}
          </span>
          <ConfigSwitch
            checked={enabled}
            loading={busy || !status}
            label={t("settings.keepaliveEnable")}
            onChange={(next) => void save(next)}
          />
        </div>

        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("settings.keepaliveServer")}</span>
            <span className="settings-option-hint">
              {t("settings.keepaliveServerValue", {
                pid: String(server?.pid ?? "-"),
                uptime: uptime ?? "-",
              })}
            </span>
            <span className="settings-option-hint">
              {t("settings.keepaliveHeartbeatValue", { age: heartbeatAge ?? "-" })}
            </span>
          </span>
        </div>

        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("settings.keepaliveSupervisor")}</span>
            <span className="settings-option-hint">
              {installed
                ? t("settings.keepaliveSupervisorInstalled", { target: supervisorTarget ?? "-" })
                : t("settings.keepaliveSupervisorMissing")}
            </span>
            <span className="settings-option-hint">
              {lastCheck
                ? t("settings.keepaliveSupervisorLastCheck", { at: lastCheck, count: String(restarts) })
                : t("settings.keepaliveSupervisorNever")}
            </span>
            {!supervisor?.scriptPath && (
              <span className="settings-option-hint">{t("settings.keepaliveScriptMissing")}</span>
            )}
          </span>
          <div className="settings-action-group">
            <ConfigButton
              className="settings-option-action"
              variant="secondary"
              disabled={actionBusy !== null || !supervisor?.scriptPath}
              onClick={() => void runAction("check")}
            >
              {t("settings.keepaliveCheckNow")}
            </ConfigButton>
            {installed ? (
              <ConfigButton
                className="settings-option-action"
                variant="ghost"
                disabled={actionBusy !== null || !supervisor?.installSupported}
                onClick={() => void runAction("uninstall")}
              >
                {t("settings.keepaliveUninstall")}
              </ConfigButton>
            ) : (
              <ConfigButton
                className="settings-option-action"
                variant="secondary"
                disabled={actionBusy !== null || !supervisor?.installSupported}
                onClick={() => void runAction("install")}
              >
                {t("settings.keepaliveInstall")}
              </ConfigButton>
            )}
            {supervisor?.stopped && (
              <ConfigButton
                className="settings-option-action"
                variant="ghost"
                disabled={actionBusy !== null || !supervisor?.scriptPath}
                onClick={() => void runAction("start")}
              >
                {t("settings.keepaliveClearStop")}
              </ConfigButton>
            )}
          </div>
        </div>

        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("settings.keepaliveResume")}</span>
            <span className="settings-option-hint">
              {autofix
                ? t("settings.keepaliveAutofixValue", {
                    active: String(autofix.active),
                    stuck: String(autofix.stuck),
                    succeeded: String(autofix.succeeded),
                    failed: String(autofix.failed),
                  })
                : t("settings.keepaliveAutofixUnavailable")}
            </span>
            <span className="settings-option-hint">
              {resumeAt
                ? t("settings.keepaliveResumeValue", { at: resumeAt, count: String(resumeCount) })
                : t("settings.keepaliveResumeNever")}
            </span>
            {interrupted > 0 && (
              <span className="settings-option-hint">
                {t("settings.keepaliveInterrupted", { count: String(interrupted) })}
              </span>
            )}
            <span className="settings-option-hint">
              {t("settings.keepaliveDataDir", { dir: status?.dataDir ?? "-" })}
            </span>
          </span>
        </div>
      </div>

      {outcome && (
        <p
          role={outcome.ok ? "status" : "alert"}
          className={outcome.ok ? "settings-option-hint" : "settings-general-error"}
          title={outcome.output}
        >
          {outcome.ok
            ? t("settings.keepaliveActionOk")
            : t("settings.keepaliveActionFailed", { code: String(outcome.exitCode ?? "-") })}
        </p>
      )}
    </section>
  );
}
