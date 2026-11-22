/**
 * Provider 故障四分类（纯函数）。
 *
 * 词表来自 pi SDK：`node_modules/@earendil-works/pi-ai/dist/utils/retry.js`
 * （pi-ai 1.5.0，`NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` 在第 4 行起、
 * `RETRYABLE_PROVIDER_ERROR_PATTERN` 在第 29 行起）。**两个常量都没有从包入口
 * 导出**（`import * as m from "@earendil-works/pi-ai"` 只有
 * `isRetryableAssistantError` / `retryAssistantCall` / `retryDelayMs` /
 * `DEFAULT_MAX_AGENT_RETRY_DELAY_MS`），所以这里逐条复制词表并标注来源；
 * SDK 升级时对着上面两个行号复核。**不要自己维护第二份词表**。
 *
 * 判据顺序（与 `isRetryableAssistantError` 对齐，再在其上细分）：
 * 1. `terminal`：401/403、鉴权失效、模型不存在、400 参数错 —— 绝不挂起；
 * 2. `quota`：SDK 的 NON_RETRYABLE_PROVIDER_LIMIT 词表（SDK 认为不可重试，但
 *    额度按小时/周期恢复，我们挂起）；
 * 3. `outage`：SDK 的 RETRYABLE 词表里属于「上游/连接/流」的那部分，以及
 *    长 `retry-after`（SDK provider 层 >60s 直接失败，正是我们该接住的部分）；
 * 4. `transient`：其余可重试项（429 短限流等）——交回 SDK 既有重试。
 *
 * 另有一条**优先于所有词表**的判据：`statusCode` 401/403/404 直接 terminal，
 * 它在错误串里未必带状态码（SDK 的 provider 错误常只带 message）。
 */

import type { OutageKind } from "./types";

// ───────────── 词表（复制自 pi-ai 1.5.0 dist/utils/retry.js:4-27 / :29-107） ─────────────

/** NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN（retry.js:4-27）的逐条副本。 */
const NON_RETRYABLE_LIMIT_PATTERNS: readonly string[] = [
  // OpenCode Go/free-tier limits returned as 429 JSON error types.
  "GoUsageLimitError",
  "FreeUsageLimitError",
  "Monthly usage limit reached",
  "available balance",
  // Generic quota/budget/billing exhaustion.
  "insufficient_quota",
  "out of budget",
  "quota exceeded",
  "billing",
  // Sign in with ChatGPT: shared usage limit / workspace admin limit.
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_workplace_individual_usage_limit_exceeded",
  // Zhipu/Z.ai error code 1308 (HTTP 429, resets after hours).
  '"code"\\s*:\\s*"?1308(?![0-9])',
];

/** RETRYABLE_PROVIDER_ERROR_PATTERN（retry.js:29-107）的逐条副本。 */
const RETRYABLE_PATTERNS: readonly string[] = [
  "overloaded",
  "server_busy",
  "servers are currently busy",
  "currently experiencing high demand",
  "model is at capacity",
  "rate.?limit",
  "too many requests",
  "(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])",
  "service.?(?:is.?)?(?:temporarily.?)?unavailable",
  "server.?error",
  "internal.?error",
  "provider.?returned.?(?:an.?)?error",
  "exceeded request buffer limit while retrying upstream",
  "unable to forward upstream",
  "upstream.?request.?failed",
  "upstream_stream_read_error",
  "stream was interrupted",
  "http/?2 stream failed",
  "network.?error",
  "connection.?error",
  "connection.?refused",
  "connection.?lost",
  "other side closed",
  "fetch failed",
  "request to \\S+ failed, reason:",
  "getaddrinfo",
  "ENOTFOUND",
  "EAI_AGAIN",
  "upstream.?connect",
  "reset before headers",
  "socket hang up",
  "socket connection was closed",
  "timed? out",
  "timeout",
  "terminated",
  "websocket.?closed",
  "websocket.?error",
  "ended without",
  "stream ended before message_stop",
  "stream ended before a terminal response event",
  "http2 request did not get a response",
  "stream disconnected before completion",
  "pending stream has been canceled",
  "retry delay",
  "you can retry your request",
  "try your request again",
  "please retry your request",
  "ResourceExhausted",
  "subscription_sharing_usage_unavailable",
  "subscription_sharing_user_unavailable",
];

/**
 * 「上游/连接/流」子集 —— 这些才是小时级不可用的信号，值得挂起。
 * 短限流词（rate limit / too many requests / 429 / overloaded / at capacity /
 * ResourceExhausted）不在此列：它们属于 `transient`，交给 SDK 的 3 次重试。
 */
const OUTAGE_PATTERNS: readonly string[] = [
  // 状态码：除 429 外的 5xx/网关错误
  "(?<![a-z0-9])(?:500|502|503|504|520|524)(?![a-z0-9])",
  "server_busy",
  "servers are currently busy",
  "service.?(?:is.?)?(?:temporarily.?)?unavailable",
  "server.?error",
  "internal.?error",
  "provider.?returned.?(?:an.?)?error",
  "exceeded request buffer limit while retrying upstream",
  "unable to forward upstream",
  "upstream.?request.?failed",
  "upstream_stream_read_error",
  "stream was interrupted",
  "http/?2 stream failed",
  "stream ended before message_stop",
  "stream ended before a terminal response event",
  "stream disconnected before completion",
  "pending stream has been canceled",
  "ended without",
  "http2 request did not get a response",
  "websocket.?closed",
  "websocket.?error",
  // 传输层
  "network.?error",
  "connection.?error",
  "connection.?refused",
  "connection.?lost",
  "other side closed",
  "fetch failed",
  "request to \\S+ failed, reason:",
  "getaddrinfo",
  "ENOTFOUND",
  "EAI_AGAIN",
  "upstream.?connect",
  "reset before headers",
  "socket hang up",
  "socket connection was closed",
  "timed? out",
  "timeout",
  "retry delay",
];

/**
 * terminal 词表：鉴权 / 模型不存在 / malformed 请求。
 * `daily limit` / `weekly limit` 一类**额度**措辞归 quota 而不是 terminal
 * （见下方 TERMINAL 判据里的负向说明）。
 */
const TERMINAL_PATTERNS: readonly string[] = [
  "invalid.?api.?key",
  "incorrect.?api.?key",
  "api.?key.?(?:is.?)?(?:invalid|missing|not.?found|expired|revoked)",
  "unauthorized",
  "forbidden",
  "authentication.?error",
  "authentication.?failed",
  "failed to authenticate",
  "re-?authenticate",
  "authentication failed for",
  "no api key",
  "no api key found",
  "credentials? (?:may )?have expired",
  // 模型不存在
  "model.?(?:is.?)?not.?found",
  "model not found",
  "no such model",
  "unknown model",
  "unsupported model",
  "invalid model",
  "does not exist.?model",
  // 400 参数错 / 请求体
  "invalid.?request",
  "invalid.?parameter",
  "malformed",
  "bad request",
  "context.?length.?exceeded",
  "maximum context length",
];

/**
 * 传输层证据：出现这些说明请求根本没到达/没走完上游，优先按 outage 处理
 * （即使文本里同时有鉴权字样）。
 */
const CONNECTION_PATTERNS: readonly string[] = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "connection.?refused",
  "connection.?lost",
  "connection.?error",
  "network.?error",
  "other side closed",
  "fetch failed",
  "getaddrinfo",
  "ENOTFOUND",
  "EAI_AGAIN",
  "upstream.?connect",
  "reset before headers",
  "socket hang up",
  "socket connection was closed",
  "timed? out",
  "timeout",
];

const nonRetryableLimitPattern = build(NON_RETRYABLE_LIMIT_PATTERNS, "limit");
const retryablePattern = build(RETRYABLE_PATTERNS, "retryable");
const outagePattern = build(OUTAGE_PATTERNS, "outage");
const terminalPattern = build(TERMINAL_PATTERNS, "terminal");
const CONNECTION_PATTERNS_RE = build(CONNECTION_PATTERNS, "connection");

function build(patterns: readonly string[], name: string): RegExp {
  try {
    return new RegExp(patterns.join("|"), "i");
  } catch (error) {
    // 词表是常量，编译失败说明本文件被改坏了；退化成永不命中，宁可漏判挂起也不误挂起。
    console.error(`[outage] failed to compile ${name} pattern:`, error instanceof Error ? error.message : error);
    return /(?!)/;
  }
}

// ───────────── 状态码 ─────────────

/** 从错误文本里抠状态码（`openai-completions` 一类 provider 的 message 常带 401/503 字样）。 */
function statusCodeFromText(errorText: string): number | undefined {
  const match = /(?<![a-z0-9])(\d{3})(?![a-z0-9])/i.exec(errorText);
  if (!match) return undefined;
  const code = Number(match[1]);
  // 只认 4xx/5xx：IP 段（127.0.0.1）与版本号里的三位数字不是 HTTP 状态。
  return code >= 400 && code <= 599 ? code : undefined;
}

// ───────────── 分类 ─────────────

export interface ClassifyOutageInput {
  /** 失败摘要（assistant message 的 errorMessage / 任务错误文本）。 */
  errorText?: string | null;
  /** provider 层拿到的 HTTP 状态码（有就比文本可靠）。 */
  statusCode?: number | null;
}

export interface OutageClassification {
  kind: OutageKind;
  /**
   * 挂起类（quota）还是临时/终态。`transient` 与 `terminal` 都返回 false；
   * 调用方要看 kind 本身决定上报方式。
   */
  suspend: boolean;
  /** 命中的词表名（排障用，不展示给用户）。 */
  matched?: "status" | "terminal" | "quota" | "outage" | "transient" | "none";
}

/**
 * 分类。空错误文本 → `transient`（没有证据表明是上游不可用；SDK 也没报错时
 * 不该挂起）。401/403/404 与 429 的状态码优先于文本判据。
 */
export function classifyOutageError(input: ClassifyOutageInput | string | null | undefined): OutageClassification {
  const normalized: ClassifyOutageInput = typeof input === "string" || input == null ? { errorText: input } : input;
  const text = (normalized.errorText ?? "").trim();
  const status = typeof normalized.statusCode === "number" && Number.isFinite(normalized.statusCode)
    ? normalized.statusCode
    : statusCodeFromText(text);

  if (!text && status == null) return { kind: "transient", suspend: false, matched: "none" };

  // 1. 状态码优先：401/403 鉴权失效、404 模型/端点不存在 —— 绝不挂起。
  //    但传输层错误码（ECONNREFUSED 等）会先被 `statusCodeFromText` 抠成 4xx/5xx
  //    数字，所以先看文本里有没有连接类证据，有就按 outage（上游没答上）。
  const connectionEvidence = CONNECTION_PATTERNS_RE.test(text);
  if ((status === 401 || status === 403) && connectionEvidence) {
    return { kind: "outage", suspend: true, matched: "outage" };
  }
  if (status === 401 || status === 403) return { kind: "terminal", suspend: false, matched: "status" };
  if (status === 404 && connectionEvidence) return { kind: "outage", suspend: true, matched: "outage" };
  if (status === 404) return { kind: "terminal", suspend: false, matched: "status" };
  // 429 的处置取决于文本：额度类 → quota 挂起；否则 transient 交回 SDK。
  if (status === 429) {
    if (nonRetryableLimitPattern.test(text)) return { kind: "quota", suspend: true, matched: "quota" };
    return { kind: "transient", suspend: false, matched: "status" };
  }
  // 408/409 是 SDK 认为可重试的短抖动；5xx 走下面的文本判据（可能细分 quota）。
  if (status === 408 || status === 409) return { kind: "transient", suspend: false, matched: "status" };

  // 2. 额度类（SDK 的 NON_RETRYABLE 词表）。放在 terminal 前面：这些多是 429/402，
  //    按小时恢复，不是鉴权错误。
  if (nonRetryableLimitPattern.test(text)) return { kind: "quota", suspend: true, matched: "quota" };

  // 3. 传输层证据优先：请求没到达/没走完上游（ECONNREFUSED / DNS / socket /
  //    timeout）就是 outage，哪怕文本里还夹着鉴权或 400 字样。
  if (connectionEvidence) return { kind: "outage", suspend: true, matched: "outage" };

  // 4. terminal 词表。鉴权文案 + 5xx 状态码仍是 outage（网关转发的 401 文案 +
  //    502 是上游挂了，不是用户凭据问题），所以 5xx 判断放在 terminal 返回之前。
  if (terminalPattern.test(text) && status != null && status >= 500) {
    return { kind: "outage", suspend: true, matched: "outage" };
  }
  if (terminalPattern.test(text)) return { kind: "terminal", suspend: false, matched: "terminal" };

  // 4. 上游/连接/流。
  if (outagePattern.test(text)) return { kind: "outage", suspend: true, matched: "outage" };

  // 5. 其余可重试项（短限流等）交回 SDK。
  if (retryablePattern.test(text)) return { kind: "transient", suspend: false, matched: "transient" };

  // 6. 不在任何词表里：保守起见按不可挂起的失败上报（绝不因「看不懂」而挂起）。
  return { kind: "terminal", suspend: false, matched: "none" };
}

/**
 * 上游明确要求的长等待（`retry-after` > 60s）：SDK 会直接失败，我们把它归
 * `outage` 并挂起。`retryAfterMs` 为毫秒。
 */
export function classifyRetryAfter(retryAfterMs: number): OutageClassification {
  return retryAfterMs > 60_000
    ? { kind: "outage", suspend: true, matched: "outage" }
    : { kind: "transient", suspend: false, matched: "status" };
}