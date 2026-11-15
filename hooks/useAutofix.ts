"use client";

import { useSyncExternalStore } from "react";
import { autofixApi } from "@/lib/autofix/client";
import type { AutofixEvent, AutofixSummary, AutofixTask } from "@/lib/autofix/types";
import { openSharedEventStream } from "@/lib/scheduled-tasks/shared-stream";

export interface AutofixState {
  tasks: AutofixTask[];
  summary: AutofixSummary;
  loaded: boolean;
  error: string | null;
}

const EMPTY_SUMMARY: AutofixSummary = { total: 0, active: 0, stuck: 0, succeeded: 0, failed: 0 };
const INITIAL: AutofixState = { tasks: [], summary: EMPTY_SUMMARY, loaded: false, error: null };

/**
 * 一个 store + 一条共享 SSE（与 Scheduled 同一套「流只说变了 → 防抖重拉列表」模式）。
 * 任务条数少、payload 小，直接整表重拉比逐条打补丁简单且不会分叉。
 */
let state = INITIAL;
const listeners = new Set<() => void>();
let stopStream: (() => void) | null = null;
let refetchTimer: ReturnType<typeof setTimeout> | null = null;
let loadId = 0;

function setState(next: Partial<AutofixState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export async function refreshAutofixTasks(): Promise<void> {
  const id = ++loadId;
  try {
    const data = await autofixApi.list();
    if (id !== loadId) return;
    setState({ tasks: data.tasks, summary: data.summary, loaded: true, error: null });
  } catch (error) {
    if (id !== loadId) return;
    setState({ loaded: true, error: error instanceof Error ? error.message : String(error) });
  }
}

function scheduleRefetch(): void {
  if (refetchTimer) return;
  refetchTimer = setTimeout(() => {
    refetchTimer = null;
    void refreshAutofixTasks();
  }, 150);
}

function handleEvent(event: AutofixEvent | { type: string }): void {
  if (event.type === "task_changed" || event.type === "task_removed") scheduleRefetch();
}

function connect(): void {
  if (stopStream) return;
  stopStream = openSharedEventStream<AutofixEvent | { type: string }>({
    url: "/api/autofix/events",
    name: "pi-web:autofix-events",
    onEvent: handleEvent,
    onOpen: () => {
      void refreshAutofixTasks();
    },
  });
}

function disconnect(): void {
  stopStream?.();
  stopStream = null;
  if (refetchTimer) clearTimeout(refetchTimer);
  refetchTimer = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    connect();
    void refreshAutofixTasks();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) disconnect();
  };
}

/** 侧边栏 badge 用：活跃任务数（含排队）。 */
export function summarizeAutofixState(current: AutofixState): { active: number; stuck: number } {
  return { active: current.summary.active, stuck: current.summary.stuck };
}

const getSnapshot = () => state;
const getServerSnapshot = () => INITIAL;

export function useAutofix(): AutofixState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
