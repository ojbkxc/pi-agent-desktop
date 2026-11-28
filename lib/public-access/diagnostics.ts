/**
 * 公网访问的**诊断事件**（server-only，两端共用契约）。
 *
 * 移植自 cc-haha 的 `desktop/electron/services/publicAccessDiagnostics.ts`，
 * 只保留能在同进程 Next 服务端复用的部分：事件形状、脱敏、写入器。
 *
 * 为什么要它：隧道连不上时现在只有一行 `console.error`，用户报「就是不行」时
 * 无从判断卡在哪一环（二进制缺失 / 代理不通 / token 被拒 / 路由没推下来 /
 * DNS 未传播 / 健康校验失败）。诊断把每一步的 stage + outcome + 耗时落下来，
 * 设置页可以直接展示「上次失败在哪一步」。
 *
 * **脱敏是硬要求**：这些事件会进日志与前端。Tunnel Token 是 base64 的 JSON
 * 凭据，代理 URL 里可能带口令，错误对象可能把两者都塞进 message —— 所有字符串
 * 先过 `sanitizeDiagnosticText` 再落。
 *
 * cc-haha 评审遗留 #2（诊断体系评估结论）：pi 的公网访问模块**已具备完整诊断
 * 能力**，无需补端点或展示。三层齐备：
 *   - 事件层：本文件的环形缓冲 + 脱敏，覆盖 start/stop 全流程的 stage/outcome；
 *   - 端点层：`POST /api/public-access/diagnose`（app/api/public-access/diagnose/
 *     route.ts）跑五项只读检查（binary / proxy / token / dns / origin）；
 *   - 展示层：ServerSection 的「连接诊断」折叠面板（事件时间线）+「检查配置」
 *     按钮（检查结果列表），均容忍服务端未返回字段时不渲染。
 * 与 cc-haha 的 publicAccessDiagnostics.ts 同源移植，能力对齐，无缺口。
 */

export type PublicAccessDiagnosticOutcome = "started" | "succeeded" | "failed" | "cancelled" | "retrying";

/**
 * 诊断事件。`stage` 是一个稳定的短标识（`preparing` / `binary` / `proxy_transport` /
 * `spawning` / `registering` / `routes` / `binding` / `verifying` / `online` / `stopping`），
 * 不要写自由文本 —— 前端按它分组。
 */
export interface PublicAccessDiagnostic {
  /** 同一次 start 尝试的所有事件共享它，便于把一轮的因果串起来。 */
  attemptId?: string;
  stage: string;
  outcome: PublicAccessDiagnosticOutcome;
  /** 该 stage 从开始到本事件的耗时。 */
  durationMs?: number;
  /** 机读原因（`invalid_cloudflare_token` / `proxy_unreachable` / …）。 */
  reason?: string;
  /** 原始错误；会被 `sanitizeDiagnostic` 深度清洗后落库。 */
  error?: unknown;
  details?: Record<string, unknown>;
}

/** 写入器：`undefined` 表示丢弃（生产默认写环形缓冲，见 `recordDiagnostic`）。 */
export type PublicAccessDiagnosticWriter = (event: PublicAccessDiagnostic) => void;

/** 单条诊断文本上限：再长就没人在设置页读得完了。 */
export const DIAGNOSTIC_TEXT_MAX = 2048;
/** 环形缓冲容量：一轮 start 通常 6–12 条，留够三次尝试。 */
export const DIAGNOSTIC_BUFFER_MAX = 40;

/**
 * 清洗一段可能含凭据的文本。
 *
 * 1. 显式 `secrets` 逐个字面替换（长的先换，避免短串把长串切碎）；
 * 2. 代理 URL 里的 `user:pass` 也还原成明文与 base64 两种形态一起换；
 * 3. 任何 `eyJ…` 形态的 JWT / cloudflared token 一律遮掉；
 * 4. URL 的查询串与片段遮掉（代理凭据常在 query 里）；
 * 5. 截断到 `DIAGNOSTIC_TEXT_MAX`。
 */
export function sanitizeDiagnosticText(text: string, secrets: readonly string[] = []): string {
  const sensitive = new Set(secrets.filter(Boolean));
  for (const value of secrets) {
    if (!value) continue;
    try {
      const url = new URL(value);
      for (const part of [url.username, url.password]) {
        if (!part) continue;
        sensitive.add(part);
        sensitive.add(decodeURIComponent(part));
      }
      if (url.username || url.password) {
        const pair = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
        sensitive.add(Buffer.from(pair).toString("base64"));
      }
    } catch {
      // 非 URL 的凭据（tunnel token 是裸 base64）仍然靠字面替换。
    }
  }

  let sanitized = text;
  for (const value of [...sensitive].sort((a, b) => b.length - a.length)) {
    sanitized = sanitized.split(value).join("[REDACTED]");
  }
  sanitized = sanitized
    .replace(/\beyJ[A-Za-z0-9_+/=-]{20,}(?:\.[A-Za-z0-9_-]+)*/g, "[REDACTED]")
    .replace(/https?:\/\/[^\s<>"')\]}]+/gi, (candidate) => {
      try {
        const url = new URL(candidate);
        const query = url.search ? "?[REDACTED]" : "";
        const hash = url.hash ? "#[REDACTED]" : "";
        return `${url.protocol}//${url.host}${url.pathname}${query}${hash}`;
      } catch {
        return "[REDACTED_URL]";
      }
    });
  return sanitized.slice(0, DIAGNOSTIC_TEXT_MAX);
}

/** 允许原样通过的短机器值（UUID / 枚举 / 系统调用名），避免一个字符的口令把错误码切碎。 */
const PASSTHROUGH_KEYS = new Set(["stage", "outcome", "reason", "mode", "step", "signal"]);
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const MACHINE_VALUE = /^[a-z0-9_:-]{1,64}$/i;
const HOST_LIKE = /^[a-z0-9.:[\]-]{1,253}$/i;

/**
 * 深度清洗一个值：字符串按上面的规则处理，对象/数组递归（深度 6、防循环），
 * 其余原样。`key` 用于放行受控的机器值。
 */
export function sanitizeDiagnosticValue(
  value: unknown,
  secrets: readonly string[] = [],
  depth = 0,
  seen = new Set<object>(),
  key = "",
): unknown {
  if (typeof value === "string") {
    if (key === "attemptId" && UUID.test(value)) return value;
    if (key === "code" && MACHINE_VALUE.test(value)) return value;
    if (key === "syscall" && MACHINE_VALUE.test(value)) return value;
    if ((key === "targetHost" || key === "proxyHost" || key === "address" || key === "proxyProtocol") && HOST_LIKE.test(value)) {
      return value;
    }
    if (key === "name" && /^(?:Error|TypeError|SyntaxError|AggregateError|AbortError|TimeoutError|CloudflareTunnelError)$/.test(value)) {
      return value;
    }
    if (PASSTHROUGH_KEYS.has(key) && MACHINE_VALUE.test(value)) return value;
    return sanitizeDiagnosticText(value, secrets);
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 6) return "[depth-limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitizeDiagnosticValue(item, secrets, depth + 1, seen, key));
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeDiagnosticText(value.message, secrets),
      ...("code" in value && MACHINE_VALUE.test(String((value as { code?: unknown }).code)) ? { code: String((value as { code?: unknown }).code) } : {}),
    };
  }
  const out: Record<string, unknown> = {};
  for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
    out[innerKey] = sanitizeDiagnosticValue(innerValue, secrets, depth + 1, seen, innerKey);
  }
  return out;
}

/** 清洗整条事件（不修改入参）。 */
export function sanitizeDiagnostic(event: PublicAccessDiagnostic, secrets: readonly string[] = []): PublicAccessDiagnostic {
  return {
    attemptId: typeof event.attemptId === "string" && UUID.test(event.attemptId) ? event.attemptId : undefined,
    stage: sanitizeDiagnosticText(String(event.stage ?? ""), secrets).slice(0, 64),
    outcome: event.outcome,
    ...(typeof event.durationMs === "number" && Number.isFinite(event.durationMs) ? { durationMs: Math.max(0, Math.round(event.durationMs)) } : {}),
    ...(event.reason === undefined ? {} : { reason: sanitizeDiagnosticText(String(event.reason), secrets).slice(0, 96) }),
    ...(event.error === undefined ? {} : { error: sanitizeDiagnosticValue(event.error, secrets) }),
    ...(event.details === undefined ? {} : { details: sanitizeDiagnosticValue(event.details, secrets) as Record<string, unknown> }),
  };
}

// ───────────────────────────── 进程内环形缓冲 ─────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __piPublicAccessDiagnostics: PublicAccessDiagnostic[] | undefined;
}

/** 取环形缓冲（热重载后仍在；用 globalThis 而不是模块级变量）。 */
export function diagnosticBuffer(): PublicAccessDiagnostic[] {
  if (!globalThis.__piPublicAccessDiagnostics) globalThis.__piPublicAccessDiagnostics = [];
  return globalThis.__piPublicAccessDiagnostics;
}

/**
 * 记录一条诊断（清洗后入缓冲）。**永不抛**：诊断失败不能影响隧道本身。
 * 生产默认实现就是它；测试可注入自己的写入器。
 */
export function recordDiagnostic(event: PublicAccessDiagnostic, secrets: readonly string[] = []): void {
  try {
    const buffer = diagnosticBuffer();
    buffer.push(sanitizeDiagnostic(event, secrets));
    while (buffer.length > DIAGNOSTIC_BUFFER_MAX) buffer.shift();
    console.log(`[public-access] ${event.stage}/${event.outcome}${event.reason ? ` (${event.reason})` : ""}`);
  } catch {
    // 诊断是旁路，绝不能把隧道带崩。
  }
}

/** 最近 N 条（新的在后），供 `GET /api/public-access` 的 diagnostics 字段用。 */
export function recentDiagnostics(limit = 20): PublicAccessDiagnostic[] {
  const buffer = diagnosticBuffer();
  return limit >= buffer.length ? [...buffer] : buffer.slice(buffer.length - limit);
}

/** 清空缓冲（测试 / 用户点「清除日志」）。 */
export function clearDiagnostics(): void {
  diagnosticBuffer().length = 0;
}

/**
 * 把一个耗时操作包成 started/succeeded|failed 一对事件。
 * 返回值与抛出都原样透传 —— 这个包装对调用方不可见。
 */
export async function withDiagnostic<T>(
  writer: PublicAccessDiagnosticWriter | undefined,
  base: { attemptId?: string; stage: string; secrets?: readonly string[] },
  operation: () => Promise<T>,
  describe?: (result: T) => Record<string, unknown> | undefined,
): Promise<T> {
  const startedAt = Date.now();
  writer?.({ ...base, outcome: "started" });
  try {
    const result = await operation();
    const details = describe?.(result);
    writer?.({
      ...base,
      outcome: "succeeded",
      durationMs: Date.now() - startedAt,
      ...(details ? { details } : {}),
    });
    return result;
  } catch (error) {
    writer?.({
      ...base,
      outcome: "failed",
      durationMs: Date.now() - startedAt,
      error,
      ...(error && typeof error === "object" && "code" in error
        ? { reason: String((error as { code?: unknown }).code) }
        : {}),
    });
    throw error;
  }
}