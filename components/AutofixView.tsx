"use client";

import { useEffect, useRef, useState } from "react";
import { AppSelect } from "./AppSelect";
import { useI18n } from "@/hooks/useI18n";
import { refreshAutofixTasks, useAutofix } from "@/hooks/useAutofix";
import { autofixApi, autofixErrorText } from "@/lib/autofix/client";
import { nextSeededCwd } from "@/lib/seed-default-cwd";
import { formatRelativeTime } from "@/lib/i18n/format";
import {
  AUTOFIX_DEFAULT_MAX_ROUNDS,
  isActiveAutofixStatus,
  type AutofixRound,
  type AutofixTask,
} from "@/lib/autofix/types";

interface Props {
  /** 新建任务时预填的工作目录（当前会话的 cwd）。 */
  defaultCwd: string | null;
  /** 打开修复会话（会话已被删除时返回 false）。 */
  onOpenSession: (sessionId: string) => Promise<boolean>;
}

const MAX_ROUND_OPTIONS = [5, 10, AUTOFIX_DEFAULT_MAX_ROUNDS];

/**
 * 「自动修复（Auto Repair）」页：一句任务说明 → 启动 → 看轮次/日志。
 *
 * 语义（与 lib/autofix 一致）：每一轮 agent 回合结束后由**服务端引擎**跑验证命令，
 * exit code 0 才算修好；失败输出自动喂回下一轮，撞轮次上限即 exhausted。
 * 本页只负责建任务 / 看进度 / 停止 / 继续 / 打开修复会话。
 */
export function AutofixView({ defaultCwd, onOpenSession }: Props) {
  const { t, locale } = useI18n();
  const { tasks, summary, loaded, error } = useAutofix();
  const [taskText, setTaskText] = useState("");
  const [cwd, setCwd] = useState(defaultCwd ?? "");
  const [verifyCommand, setVerifyCommand] = useState("");
  const [maxRounds, setMaxRounds] = useState(String(AUTOFIX_DEFAULT_MAX_ROUNDS));
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const cwdSeededRef = useRef(false);
  const cwdEditedRef = useRef(false);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  // 当前会话 cwd 后来才解析出来时补一个空值。只 seed 一次：用户清空/改过之后
  // 不再回弹（此前 `if (!cwd && defaultCwd)` 每次渲染都会把空值填回默认目录）。
  useEffect(() => {
    const decision = nextSeededCwd(
      { seeded: cwdSeededRef.current, userEdited: cwdEditedRef.current },
      cwd,
      defaultCwd,
    );
    cwdSeededRef.current = decision.seeded;
    if (decision.value !== null) setCwd(decision.value);
  }, [cwd, defaultCwd]);

  async function act(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setActionError(null);
    try {
      await action();
      await refreshAutofixTasks();
    } catch (caught) {
      setActionError(autofixErrorText(caught, t));
    } finally {
      setBusy(null);
    }
  }

  // 列表加载失败后的手动重试：refreshAutofixTasks 把错误写进共享 store（自身不抛出），
  // 所以这里只负责短暂的 busy 反馈，不必等共享 SSE 的下一次刷新。
  async function reload() {
    setBusy("reload");
    setActionError(null);
    try {
      await refreshAutofixTasks();
    } finally {
      setBusy(null);
    }
  }

  async function start() {
    setActionError(null);
    if (!taskText.trim()) {
      setActionError(t("autofix.error.taskRequired"));
      return;
    }
    await act("create", async () => {
      await autofixApi.create({
        task: taskText,
        cwd,
        ...(verifyCommand.trim() ? { verifyCommand: verifyCommand.trim() } : {}),
        maxRounds: Number(maxRounds) || AUTOFIX_DEFAULT_MAX_ROUNDS,
      });
      setTaskText("");
      setVerifyCommand("");
    });
  }

  async function openSession(task: AutofixTask) {
    if (!task.sessionId) return;
    setActionError(null);
    if (!(await onOpenSession(task.sessionId))) {
      setActionError(t("autofix.sessionMissing"));
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // 逐字面量返回（不用模板拼键）：lib/i18n/registry.test.mjs 只保证三语同形，
  // 动态拼键缺键时界面会把键名本身渲染出来，静态调用点门禁也看不见。
  const statusLabel = (task: AutofixTask) => {
    switch (task.status) {
      case "queued":
        return t("autofix.status.queued");
      case "running":
        return t("autofix.status.running");
      case "verifying":
        return t("autofix.status.verifying");
      case "succeeded":
        return t("autofix.status.succeeded");
      case "failed":
        return t("autofix.status.failed");
      case "exhausted":
        return t("autofix.status.exhausted");
      case "stopped":
        return t("autofix.status.stopped");
      case "waiting-provider":
        return t("autofix.status.waitingProvider");
      default:
        return task.status;
    }
  };
  const statusDotClass = (task: AutofixTask) => {
    if (task.status === "running" || task.status === "verifying") return "scheduled-status-dot scheduled-status-dot--running";
    if (task.status === "succeeded") return "scheduled-status-dot scheduled-status-dot--active";
    if (task.status === "failed" || task.status === "exhausted") return "scheduled-status-dot scheduled-status-dot--attention";
    return "scheduled-status-dot";
  };

  return (
    <section
      ref={rootRef}
      className="scheduled-view"
      tabIndex={-1}
      aria-label={t("autofix.title")}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.preventDefault();
      }}
    >
      <div className="scheduled-shell">
        <header className="scheduled-header">
          <div>
            <h2 className="scheduled-title">{t("autofix.title")}</h2>
            <p className="scheduled-subtitle">{t("autofix.subtitle")}</p>
          </div>
        </header>

        {/* ── 新建任务 ── */}
        <div className="scheduled-form">
          <div className="scheduled-field">
            <label htmlFor="autofix-task">{t("autofix.taskLabel")}</label>
            <textarea
              id="autofix-task"
              className="scheduled-input scheduled-textarea"
              rows={3}
              value={taskText}
              onChange={(event) => setTaskText(event.target.value)}
              placeholder={t("autofix.taskPlaceholder")}
            />
          </div>
          <div className="scheduled-grid">
            <div className="scheduled-field">
              <label htmlFor="autofix-cwd">{t("autofix.cwdLabel")}</label>
              <input
                id="autofix-cwd"
                className="scheduled-input"
                value={cwd}
                onChange={(event) => { cwdEditedRef.current = true; setCwd(event.target.value); }}
                placeholder={t("autofix.cwdPlaceholder")}
                spellCheck={false}
              />
            </div>
            <div className="scheduled-field">
              <label htmlFor="autofix-verify">{t("autofix.verifyLabel")}</label>
              <input
                id="autofix-verify"
                className="scheduled-input"
                value={verifyCommand}
                onChange={(event) => setVerifyCommand(event.target.value)}
                placeholder={t("autofix.verifyPlaceholder")}
                spellCheck={false}
              />
              <span className="scheduled-inline">{t("autofix.verifyHint")}</span>
            </div>
            <div className="scheduled-field">
              <span>{t("autofix.maxRoundsLabel")}</span>
              <AppSelect
                aria-label={t("autofix.maxRoundsLabel")}
                value={maxRounds}
                onValueChange={setMaxRounds}
                options={MAX_ROUND_OPTIONS.map((rounds) => ({ value: String(rounds), label: String(rounds) }))}
              />
            </div>
          </div>
          <div className="scheduled-actions">
            <button
              type="button"
              className="scheduled-button scheduled-button--primary"
              disabled={busy !== null || !taskText.trim() || !cwd.trim()}
              onClick={() => void start()}
            >
              {busy === "create" ? t("autofix.starting") : t("autofix.start")}
            </button>
            <span className="scheduled-inline">
              {t("autofix.summaryLine", {
                active: summary.active,
                succeeded: summary.succeeded,
                failed: summary.failed,
              })}
            </span>
          </div>
        </div>

        {actionError && <p className="scheduled-error" role="alert">{actionError}</p>}
        {error && (
          <p className="scheduled-error" role="alert">
            {t("autofix.loadFailed", { error })}
            <button
              type="button"
              className="scheduled-button scheduled-button--small"
              style={{ marginLeft: 8 }}
              disabled={busy !== null}
              onClick={() => void reload()}
            >
              {t("autofix.retry")}
            </button>
          </p>
        )}

        {/* ── 任务列表 ── */}
        {!loaded && <p className="scheduled-inline">{t("autofix.loading")}</p>}
        {/* 失败时 store 会保留 tasks=[]，若不加 !error 错误与空态会同屏出现（interaction.md P2）。 */}
        {loaded && !error && tasks.length === 0 && (
          <div className="scheduled-empty">
            <h3>{t("autofix.emptyTitle")}</h3>
            <p>{t("autofix.emptyBody")}</p>
          </div>
        )}
        {tasks.length > 0 && (
          <ul className="scheduled-list">
            {tasks.map((task) => {
              const isActive = isActiveAutofixStatus(task.status);
              const isExpanded = expanded.has(task.id);
              return (
                <li key={task.id}>
                  <div className="scheduled-card" style={{ flexDirection: "column", alignItems: "stretch", cursor: "default" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span className={statusDotClass(task)} aria-hidden="true" />
                      <button
                        type="button"
                        className="scheduled-card-main"
                        style={{ background: "none", border: 0, padding: 0, color: "inherit", cursor: "pointer", textAlign: "left" }}
                        onClick={() => toggleExpanded(task.id)}
                        aria-expanded={isExpanded}
                      >
                        <span className="scheduled-card-name">{task.task.split(/\r?\n/, 1)[0]}</span>
                        <span className="scheduled-card-meta" style={{ flexDirection: "row", alignItems: "center", gap: 8, textAlign: "left" }}>
                          <span className={`scheduled-tag${isActive ? " scheduled-tag--running" : ""}`}>{statusLabel(task)}</span>
                          <span>{t("autofix.roundOf", { round: task.round, max: task.maxRounds })}</span>
                          <span>{formatRelativeTime(new Date(task.updatedAt), locale)}</span>
                        </span>
                      </button>
                      <div className="scheduled-actions">
                        {isActive && (
                          <button
                            type="button"
                            className="scheduled-button scheduled-button--small"
                            disabled={busy !== null}
                            onClick={() => void act(`stop:${task.id}`, () => autofixApi.stop(task.id))}
                          >
                            {t("autofix.stop")}
                          </button>
                        )}
                        {!isActive && task.status !== "succeeded" && (
                          <button
                            type="button"
                            className="scheduled-button scheduled-button--small"
                            disabled={busy !== null}
                            onClick={() => void act(`resume:${task.id}`, () => autofixApi.resume(task.id))}
                          >
                            {t("autofix.resume")}
                          </button>
                        )}
                        {task.sessionId && (
                          <button
                            type="button"
                            className="scheduled-button scheduled-button--small"
                            disabled={busy !== null}
                            onClick={() => void openSession(task)}
                          >
                            {t("autofix.openSession")}
                          </button>
                        )}
                        {confirmDelete === task.id ? (
                          <button
                            type="button"
                            className="scheduled-button scheduled-button--small scheduled-button--danger"
                            disabled={busy !== null}
                            onClick={() => {
                              setConfirmDelete(null);
                              void act(`delete:${task.id}`, () => autofixApi.remove(task.id));
                            }}
                          >
                            {t("autofix.deleteConfirm")}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="scheduled-button scheduled-button--small scheduled-button--danger"
                            disabled={busy !== null}
                            onClick={() => setConfirmDelete(task.id)}
                          >
                            {t("autofix.delete")}
                          </button>
                        )}
                      </div>
                    </div>
                    {task.lastError && (
                      <p className="scheduled-inline autofix-last-error" title={task.lastError}>
                        {t("autofix.lastError")}: {task.lastError}
                      </p>
                    )}
                    {isExpanded && (
                      <AutofixRounds task={task} />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function roundStatusLabel(t: (key: string) => string, round: AutofixRound): string {
  switch (round.status) {
    case "agent-done":
      return t("autofix.roundStatus.agent-done");
    case "agent-error":
      return t("autofix.roundStatus.agent-error");
    case "verify-passed":
      return t("autofix.roundStatus.verify-passed");
    case "verify-failed":
      return t("autofix.roundStatus.verify-failed");
    case "timeout":
      return t("autofix.roundStatus.timeout");
    default:
      return round.status;
  }
}

function AutofixRounds({ task }: { task: AutofixTask }) {
  const { t, locale } = useI18n();
  if (task.rounds.length === 0) {
    return <p className="scheduled-inline">{t("autofix.roundsEmpty")}</p>;
  }
  return (
    <details open>
      <summary className="scheduled-inline">{t("autofix.roundsTitle")}</summary>
      <ul className="autofix-rounds">
        {task.rounds.map((round, index) => (
          <li key={`${round.round}-${round.at}-${index}`} className="autofix-round">
            <div className="autofix-round-head">
              <span className="scheduled-tag">{`#${round.round}`}</span>
              <span>{roundStatusLabel(t, round)}</span>
              {round.verifyExitCode !== null && (
                <span className="scheduled-mono">{t("autofix.verifyExit", { code: round.verifyExitCode })}</span>
              )}
              <span className="scheduled-inline">{formatRelativeTime(new Date(round.at), locale)}</span>
            </div>
            {round.error && <p className="autofix-round-error">{round.error}</p>}
            {round.outputTail && <pre className="scheduled-mono autofix-round-output">{round.outputTail}</pre>}
          </li>
        ))}
      </ul>
    </details>
  );
}
