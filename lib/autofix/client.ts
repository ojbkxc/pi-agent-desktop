import type { AutofixSummary, AutofixTask } from "./types";

/** 浏览器侧 /api/autofix 封装。只 import 类型；不碰任何 server-only 模块。 */

export class AutofixApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** 校验错误的 i18n 键与参数，页面用当前语言显示。 */
    readonly key?: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "AutofixApiError";
  }
}

const BASE = "/api/autofix";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    key?: string;
    params?: Record<string, string | number>;
  } & Record<string, unknown>;
  if (!response.ok) {
    throw new AutofixApiError(body.error ?? `HTTP ${response.status}`, response.status, body.code, body.key, body.params);
  }
  return body as T;
}

export interface CreateAutofixInput {
  task: string;
  cwd: string;
  verifyCommand?: string;
  maxRounds?: number;
}

export const autofixApi = {
  list: () => request<{ tasks: AutofixTask[]; summary: AutofixSummary }>(""),
  create: (input: CreateAutofixInput) =>
    request<{ task: AutofixTask }>("", { method: "POST", body: JSON.stringify(input) }),
  get: (id: string) => request<{ task: AutofixTask }>(`/${encodeURIComponent(id)}`),
  stop: (id: string) =>
    request<{ task: AutofixTask }>(`/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ action: "stop" }),
    }),
  resume: (id: string) =>
    request<{ task: AutofixTask }>(`/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ action: "resume" }),
    }),
  remove: (id: string) =>
    request<{ success: true }>(`/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

/** API 错误 → 当前语言的文案（校验错误带 key，其余回退英文 message）。 */
export function autofixErrorText(
  error: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (error instanceof AutofixApiError && error.key) return t(error.key, error.params);
  return error instanceof Error ? error.message : String(error);
}
