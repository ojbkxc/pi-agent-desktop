"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { OutageSnapshot } from "@/lib/outage/types";

const POLL_MS = 5000;

/**
 * Provider 中断自愈的会话头部横幅（docs/agents/fork-provider-outage-resume.md §6）：
 * 上游不可用时会话挂起等待，横幅说明「在等什么、第几次探测」，并给「立即重试 /
 * 取消等待」。**只在该会话有 waiting 记录时渲染**，平时返回 null 不占位。
 *
 * 数据直接读 `/api/outage`（GET 返回全部 waiting 记录，按 sessionId 过滤）：
 * 这份状态是运行期的（调度器写盘、rpc-manager 只投影给 Tasks 页），AppShell
 * 拿不到，所以组件自取，避免把轮询塞进 ChatWindow。
 */
export function OutageBanner({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n();
  const [record, setRecord] = useState<OutageSnapshot | null>(null);
  const [acting, setActing] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setRecord(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch("/api/outage", { cache: "no-store" });
        if (response.ok) {
          const data = await response.json() as { records?: OutageSnapshot[] };
          if (!cancelled) {
            setRecord((data.records ?? []).find((entry) => entry.sessionId === sessionId) ?? null);
          }
        }
      } catch {
        // Offline: keep the last banner; the next tick re-reads.
      }
      if (!cancelled) {
        timer = setTimeout(() => {
          if (document.visibilityState === "visible") void load();
        }, POLL_MS);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  // 用户动作后先收起横幅；下一轮轮询按记录的真实状态重新显示（重试再失败会再出现）。
  const act = async (action: "retry" | "cancel") => {
    if (!sessionId) return;
    setActing(true);
    try {
      await fetch("/api/outage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, sessionId }),
      });
      setRecord(null);
    } catch {
      // The banner stays; the user can press again.
    } finally {
      setActing(false);
    }
  };

  if (!record) return null;

  return (
    <div className="outage-banner" role="status">
      <span className="outage-banner-text">
        {t(record.kind === "quota" ? "outage.bannerQuota" : "outage.banner", {
          attempt: record.attempts,
          max: record.maxAttempts,
        })}
      </span>
      <span className="outage-banner-actions">
        <button type="button" className="tasks-action" disabled={acting} onClick={() => void act("retry")}>
          {t("tasks.retryNow")}
        </button>
        <button type="button" className="tasks-action" disabled={acting} onClick={() => void act("cancel")}>
          {t("tasks.cancelWait")}
        </button>
      </span>
    </div>
  );
}