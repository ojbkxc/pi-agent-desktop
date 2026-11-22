"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatRelativeTime } from "@/lib/i18n/format";
import type { BackgroundJob, BackgroundJobStatus } from "@/lib/background-jobs/types";
import { createTasksPoller } from "./tasks-helpers";

// A running command's status changes faster than its 3s list did; a finished one
// stops polling until the next focus/visibility refresh.
const REFRESH_MS = 3000;

/**
 * Status → i18n key. A static map (not `t(\`…${status}\`)`) so the keys are read
 * as literals by lib/i18n/usage.test.mjs, and so registry.test.mjs sees them in
 * all three locales.
 */
export const BACKGROUND_JOB_STATUS_KEY: Record<BackgroundJobStatus, string> = {
  running: "tasks.background.status.running",
  completed: "tasks.background.status.completed",
  failed: "tasks.background.status.failed",
  stopped: "tasks.background.status.stopped",
  timedout: "tasks.background.status.timedout",
  interrupted: "tasks.background.status.interrupted",
};

/** One-line command preview: collapsed whitespace, truncated for the row. */
export function backgroundCommandPreview(command: string, limit = 120): string {
  const flat = command.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, Math.max(0, limit - 1))}…`;
}

/** Dot tone: running is live, failed/timed-out are errors, everything else is done. */
export function backgroundStatusTone(status: BackgroundJobStatus): "running" | "failed" | "done" {
  if (status === "running") return "running";
  if (status === "failed" || status === "timedout") return "failed";
  return "done";
}

interface ListProps {
  jobs: BackgroundJob[];
  stoppingId?: string | null;
  stopFailedId?: string | null;
  onStop: (id: string) => void;
}

/**
 * Presentational list. Split from the polling container so a test can render it
 * with a fixed set of jobs (the container fetches in an effect, which SSR skips).
 */
export function BackgroundJobsList({ jobs, stoppingId, stopFailedId, onStop }: ListProps) {
  const { t, locale } = useI18n();
  return (
    <section className="tasks-section" aria-labelledby="tasks-background">
      <h3 id="tasks-background" className="tasks-section-title">
        {t("tasks.background.title")}
        <span className="tasks-section-count">{jobs.length}</span>
      </h3>
      <ul className="scheduled-list">
        {jobs.map((job) => {
          const tone = backgroundStatusTone(job.status);
          const started = formatRelativeTime(new Date(job.startedAt), locale);
          const statusLabel = t(BACKGROUND_JOB_STATUS_KEY[job.status]);
          const exit = typeof job.exitCode === "number"
            ? ` · ${t("tasks.background.exit", { code: job.exitCode })}`
            : "";
          const running = job.status === "running";
          return (
            <li key={job.id}>
              <div className="scheduled-card tasks-card tasks-background-card">
                <span className={`scheduled-status-dot tasks-dot--${tone}`} aria-hidden="true" />
                <span className="scheduled-card-main tasks-background-main">
                  <span className="scheduled-card-name tasks-background-command" title={job.command}>
                    {job.label ? `${job.label} — ${backgroundCommandPreview(job.command)}` : backgroundCommandPreview(job.command)}
                  </span>
                  <span className={`scheduled-hint tasks-status tasks-status--${tone}`}>
                    {statusLabel} · {started}{exit}
                  </span>
                  {stopFailedId === job.id && (
                    <span className="scheduled-error" role="alert">{t("tasks.background.stopFailed")}</span>
                  )}
                </span>
                {running && (
                  <button
                    type="button"
                    className="tasks-action tasks-background-stop"
                    disabled={stoppingId === job.id}
                    onClick={() => onStop(job.id)}
                  >
                    {stoppingId === job.id ? t("tasks.background.stopping") : t("tasks.background.stop")}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Background commands on the Tasks page: the UI's path to the jobs the model
 * started with `bash_background` (the tools are the model's path). Lists
 * running and recent jobs, shows status + command, and stops a running one
 * through `POST /api/background-jobs?id=` (already implemented server side).
 *
 * Polls only while the page is visible (and on focus), like the rest of Tasks;
 * no new SSE stream.
 */
export function BackgroundJobsSection() {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<BackgroundJob[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [stopFailedId, setStopFailedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/background-jobs", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { jobs?: unknown };
    return Array.isArray(data.jobs) ? (data.jobs as BackgroundJob[]) : [];
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poller = createTasksPoller({
      intervalMs: REFRESH_MS,
      isVisible: () => document.visibilityState === "visible",
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      load: async () => {
        try {
          const list = await load();
          if (!cancelled) {
            setJobs(list);
            setFailed(false);
          }
          return { live: list.some((job) => job.status === "running") };
        } catch (error) {
          if (!cancelled) setFailed(true);
          throw error;
        }
      },
    });
    const refresh = () => void poller.onVisibilityChange();
    void poller.start();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      poller.stop();
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  const stopJob = async (id: string) => {
    setStoppingId(id);
    setStopFailedId(null);
    try {
      const response = await fetch(`/api/background-jobs?id=${encodeURIComponent(id)}`, { method: "POST" });
      // 409 = the job already finished; that is not an error for the user.
      if (!response.ok && response.status !== 409) throw new Error(`HTTP ${response.status}`);
    } catch {
      setStopFailedId(id);
    } finally {
      setStoppingId(null);
      try {
        setJobs(await load());
      } catch {
        // The next poll (or a focus refresh) corrects the list.
      }
    }
  };

  // Nothing to show: the section only appears once the model has started a job,
  // matching the Tasks page's "render a group only when it has rows" rule.
  if (jobs === null || jobs.length === 0) return null;

  return (
    <div className="tasks-background">
      {failed && <p className="scheduled-error" role="alert">{t("tasks.background.loadFailed")}</p>}
      <BackgroundJobsList
        jobs={jobs}
        stoppingId={stoppingId}
        stopFailedId={stopFailedId}
        onStop={(id) => void stopJob(id)}
      />
    </div>
  );
}
