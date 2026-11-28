"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { APP_PREF_KEYS, getPref, setPref } from "@/lib/app-prefs";
import { formatRelativeTime } from "@/lib/i18n/format";
import type { OutageSnapshot } from "@/lib/outage/types";
import type { AgentTaskSnapshot, SessionInfo } from "@/lib/types";
import { createTasksPoller, describeActivity, groupTasks, projectLabel, sessionTitle, type TaskRow } from "./tasks-helpers";
import { BackgroundJobsSection } from "./BackgroundJobsSection";
import { TaskCalendar } from "./TaskCalendar";

interface Props {
  sessions: SessionInfo[];
  /** From the sidebar's running stream; a change refetches at once. */
  runningSessionIds: ReadonlySet<string>;
  /** `entryId` scrolls the opened session to that message. */
  onOpenSession: (sessionId: string, entryId?: string) => void;
  /** Opens the Scheduled page on this task's detail. */
  onOpenScheduledTask: (taskId: string) => void;
}

type TasksMode = "list" | "calendar";

// While something runs, the current step changes faster than the running set does.
const LIVE_REFRESH_MS = 3000;

/**
 * The Tasks page: what needs the user, what is running and on which step, and
 * what finished lately. Built for following work from a phone (Settings › Remote
 * access); opening a row goes to the session, where its dialog can be answered.
 */
export function TasksView({ sessions, runningSessionIds, onOpenSession, onOpenScheduledTask }: Props) {
  const { t, locale } = useI18n();
  const [mode, setModeState] = useState<TasksMode>(() => (getPref(APP_PREF_KEYS.tasksMode) === "calendar" ? "calendar" : "list"));
  const [snapshots, setSnapshots] = useState<AgentTaskSnapshot[] | null>(null);
  // Outage records are supplementary: they add the retry counter to the
  // "waiting for the provider" row, never gate whether the row appears.
  const [outageRecords, setOutageRecords] = useState<Record<string, OutageSnapshot>>({});
  const [actingSessionId, setActingSessionId] = useState<string | null>(null);
  const [actionTick, setActionTick] = useState(0);
  const [failed, setFailed] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const runningKey = [...runningSessionIds].sort().join(",");

  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, []);

  useEffect(() => {
    let cancelled = false;
    const poller = createTasksPoller({
      intervalMs: LIVE_REFRESH_MS,
      isVisible: () => document.visibilityState === "visible",
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      load: async () => {
        try {
          // Both reads in one tick: the tasks endpoint decides the rows, the
          // outage endpoint only decorates them. A failed outage read leaves the
          // rows on the plain waiting copy instead of hiding them.
          const [tasksResponse, outageResponse] = await Promise.all([
            fetch("/api/agent/tasks", { cache: "no-store" }),
            fetch("/api/outage", { cache: "no-store" }).catch(() => null),
          ]);
          if (!tasksResponse.ok) throw new Error(`HTTP ${tasksResponse.status}`);
          const data = await tasksResponse.json() as { tasks: AgentTaskSnapshot[] };
          const records: Record<string, OutageSnapshot> = {};
          if (outageResponse?.ok) {
            try {
              const outage = await outageResponse.json() as { records?: OutageSnapshot[] };
              for (const record of outage.records ?? []) records[record.sessionId] = record;
            } catch { /* malformed body: keep the rows, drop the counters */ }
          }
          if (!cancelled) {
            setSnapshots(data.tasks);
            setOutageRecords(records);
            setFailed(false);
          }
          return {
            live: data.tasks.some((task) => task.running || task.waiting.length > 0 || task.waitingForProvider === true),
          };
        } catch (error) {
          if (!cancelled) setFailed(true);
          throw error;
        }
      },
    });
    const onVisible = () => void poller.onVisibilityChange();
    void poller.start();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      poller.stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [runningKey, actionTick]);

  const groups = useMemo(
    () => groupTasks(sessions, snapshots ?? [], runningSessionIds),
    [sessions, snapshots, runningSessionIds],
  );

  // One action per row: retry resumes on the next scheduler tick, cancel stops
  // waiting for good (same path as Stop in the chat, but without the user
  // needing to open the session first).
  const actOnOutage = async (action: "retry" | "cancel", sessionId: string) => {
    setActingSessionId(sessionId);
    try {
      await fetch("/api/outage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, sessionId }),
      });
    } catch {
      // The next poll re-reads the truth; a failed action changes nothing.
    } finally {
      setActingSessionId(null);
      setActionTick((tick) => tick + 1);
    }
  };

  const renderRow = (row: TaskRow) => {
    const { session, snapshot } = row;
    const failedRun = snapshot?.lastRun?.outcome.status === "failed" ? snapshot.lastRun.outcome : null;
    const outage = outageRecords[session.id];
    let status: string;
    let tone: "attention" | "running" | "failed" | "done";
    if (row.group === "waiting") {
      tone = "attention";
      const prompt = snapshot?.waiting[0]?.prompt;
      status = prompt ? t("tasks.waitingFor", { prompt }) : t("tasks.waiting");
    } else if (row.group === "outage") {
      // Suspended, not failed: amber like the Waiting group, never red (§4.1).
      tone = "attention";
      status = outage
        ? t(outage.kind === "quota" ? "tasks.waitingQuota" : "tasks.waitingProviderRetry", {
          attempt: outage.attempts,
          max: outage.maxAttempts,
        })
        : t("tasks.waitingProvider");
    } else if (row.group === "running") {
      tone = "running";
      const activity = describeActivity(snapshot?.activity ?? null, t);
      status = snapshot?.runStartedAt
        ? t("tasks.runningSince", { activity, time: formatRelativeTime(new Date(snapshot.runStartedAt), locale) })
        : activity;
    } else if (failedRun) {
      tone = "failed";
      status = failedRun.error ? t("tasks.failedWith", { error: failedRun.error }) : t("tasks.failed");
    } else {
      tone = "done";
      status = formatRelativeTime(new Date(snapshot?.lastRun?.finishedAt ?? session.modified), locale);
    }
    return (
      <li key={session.id}>
        <button type="button" className="scheduled-card tasks-card" onClick={() => onOpenSession(session.id)}>
          <span className={`scheduled-status-dot tasks-dot--${tone}`} aria-hidden="true" />
          <span className="scheduled-card-main">
            <span className="scheduled-card-name">{sessionTitle(session) || t("appshell.untitledTask")}</span>
            <span className={`scheduled-hint tasks-status tasks-status--${tone}`}>{status}</span>
          </span>
          <span className="scheduled-card-meta">
            <span className="scheduled-hint">{projectLabel(session, t("workspace.chatTitle"))}</span>
          </span>
        </button>
        {row.group === "outage" && (
          <div className="tasks-card-actions">
            <button
              type="button"
              className="tasks-action"
              disabled={actingSessionId === session.id}
              onClick={() => void actOnOutage("retry", session.id)}
            >
              {t("tasks.retryNow")}
            </button>
            <button
              type="button"
              className="tasks-action"
              disabled={actingSessionId === session.id}
              onClick={() => void actOnOutage("cancel", session.id)}
            >
              {t("tasks.cancelWait")}
            </button>
          </div>
        )}
      </li>
    );
  };

  const section = (key: "waiting" | "outage" | "running" | "recent", rows: TaskRow[]) => rows.length > 0 && (
    <section
      className={`tasks-section${key === "waiting" || key === "outage" ? " tasks-section--attention" : ""}`}
      aria-labelledby={`tasks-${key}`}
    >
      <h3 id={`tasks-${key}`} className="tasks-section-title">
        {(key === "waiting" || key === "outage") && <span className="tasks-section-dot" aria-hidden="true" />}
        {t(`tasks.section.${key}`)}
        <span className="tasks-section-count">{rows.length}</span>
      </h3>
      <ul className="scheduled-list">{rows.map(renderRow)}</ul>
    </section>
  );

  const setMode = (next: TasksMode) => {
    setModeState(next);
    setPref(APP_PREF_KEYS.tasksMode, next);
  };
  const modeSwitch = (
    <div className="task-seg" role="group" aria-label={t("tasks.modeLabel")}>
      <button type="button" aria-pressed={mode === "list"} onClick={() => setMode("list")}>{t("tasks.mode.list")}</button>
      <button type="button" aria-pressed={mode === "calendar"} onClick={() => setMode("calendar")}>{t("tasks.mode.calendar")}</button>
    </div>
  );

  if (mode === "calendar") {
    return (
      <main ref={rootRef} tabIndex={-1} className="scheduled-view tasks-view tasks-view--calendar" aria-label={t("tasks.title")}>
        <TaskCalendar
          sessions={sessions}
          snapshots={snapshots ?? []}
          runningSessionIds={runningSessionIds}
          modeSwitch={modeSwitch}
          onOpenSession={onOpenSession}
          onOpenScheduledTask={onOpenScheduledTask}
        />
      </main>
    );
  }

  return (
    <main
      ref={rootRef}
      tabIndex={-1}
      className="scheduled-view tasks-view"
      aria-label={t("tasks.title")}
      onKeyDown={(event) => {
        // 整页视图盖在聊天列上，聊天与 AgentSession 并未卸载：Esc 不拦会冒泡到
        // window 的全局快捷键，把后台仍在运行的 agent 停掉。与 ScheduledView /
        // AutofixView 一致，只吞掉 Escape。
        if (event.key === "Escape") event.preventDefault();
      }}
    >
      <div className="scheduled-shell">
        <header className="scheduled-header">
          <div>
            <h2 className="scheduled-title">{t("tasks.title")}</h2>
            <p className="scheduled-subtitle">{t("tasks.subtitle")}</p>
          </div>
          {modeSwitch}
        </header>
        {failed && <p className="scheduled-error" role="alert">{t("tasks.loadFailed")}</p>}
        {snapshots === null && !failed && <p className="scheduled-hint">{t("tasks.loading")}</p>}
        {snapshots !== null && groups.waiting.length + groups.outage.length + groups.running.length === 0 && (
          <p className="scheduled-hint">{t("tasks.nothingRunning")}</p>
        )}
        {section("waiting", groups.waiting)}
        {section("outage", groups.outage)}
        {section("running", groups.running)}
        {section("recent", groups.recent)}
        {/* Background commands the assistant started (bash_background): the UI's
            list + stop path. Self-hides until at least one job exists. */}
        <BackgroundJobsSection />
      </div>
    </main>
  );
}
