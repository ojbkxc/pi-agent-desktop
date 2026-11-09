/**
 * 市场上游请求的共用层：超时、一次性重试、响应体大小上限、来源健康记账。
 *
 * 与 cc-haha 的 `providerFetch.ts` 同职责。这里**不**读用户的网络代理设置（本仓没有那条
 * 链路），但保留了同样的两个环境变量钩子，便于测试与自建镜像：
 * `PI_MARKET_BASE_CLAWHUB` / `PI_MARKET_BASE_SKILLHUB`，以及
 * `PI_MARKET_DISABLE_PROVIDERS=clawhub,skillhub`。
 */

import { MarketUpstreamError, type MarketSource } from "./types";

const DEFAULT_BASES: Record<MarketSource, string> = {
  clawhub: "https://clawhub.ai",
  skillhub: "https://api.skillhub.cn",
};

const REQUEST_TIMEOUT_MS = 10_000;

/** 单个 JSON 响应体的上限：列表页很小，详情页可能带整段 SKILL.md。 */
const MAX_JSON_BYTES = 8 * 1024 * 1024;

export function getProviderBase(source: MarketSource): string {
  const key = source === "clawhub" ? "PI_MARKET_BASE_CLAWHUB" : "PI_MARKET_BASE_SKILLHUB";
  return process.env[key]?.trim() || DEFAULT_BASES[source];
}

export function isProviderDisabled(source: MarketSource): boolean {
  const disabled = process.env.PI_MARKET_DISABLE_PROVIDERS;
  if (!disabled) return false;
  return disabled.split(",").map((item) => item.trim()).includes(source);
}

/** 每个来源最近一次请求的结果，供 UI 显示「某源已降级 / 不可用」。 */
export interface SourceHealth {
  status: "ok" | "failed";
  at: number;
  message?: string;
}

// globalThis 而不是模块级 Map：Next 的热重载会重建模块，来源健康要跨重载保留。
const registry = globalThis as typeof globalThis & { __piMarketHealth?: Map<MarketSource, SourceHealth> };

export function getSourceHealth(): Record<string, SourceHealth | undefined> {
  const health = registry.__piMarketHealth;
  return Object.fromEntries(MARKET_SOURCE_LIST.map((source) => [source, health?.get(source)]));
}

const MARKET_SOURCE_LIST: MarketSource[] = ["clawhub", "skillhub"];

function record(source: MarketSource, entry: SourceHealth): void {
  const health = registry.__piMarketHealth ??= new Map();
  health.set(source, entry);
}

/** 读一个响应体，越过上限就中止并报错（不静默截断，下游会拿到半个 JSON）。 */
export async function readTextWithLimit(
  source: MarketSource,
  response: Response,
  maxBytes: number,
  label: string,
): Promise<{ content: string; size: number }> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MarketUpstreamError(source, "upstreamBadResponse", `${source} ${label} exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return { content: "", size: 0 };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new MarketUpstreamError(source, "upstreamBadResponse", `${source} ${label} exceeds ${maxBytes} bytes`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return { content: chunks.join(""), size: total };
  } finally {
    reader.releaseLock();
  }
}

async function fetchOnce(source: MarketSource, url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    // 一部分 CDN 会按 UA 拒绝空 UA 的请求；带上本产品标识，便于对方排查。
    headers: { "user-agent": "pi-agent-desktop-skill-market", ...(init?.headers ?? {}) },
  });
}

/**
 * 一个上游请求：10s 超时 + 一次重试（仅网络类失败与 5xx/429；4xx 不重试）。
 * 结果写入来源健康表。
 */
export async function providerFetch(source: MarketSource, url: string, init?: RequestInit): Promise<Response> {
  if (isProviderDisabled(source)) {
    throw new MarketUpstreamError(source, "sourceUnavailable", `${source} is disabled by PI_MARKET_DISABLE_PROVIDERS`);
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchOnce(source, url, init);
      if (response.status >= 500 || response.status === 429) {
        lastError = new MarketUpstreamError(source, "upstreamError", `${source} responded ${response.status}`);
        if (attempt === 0) continue;
      }
      record(source, response.ok || response.status < 500
        ? { status: "ok", at: Date.now() }
        : { status: "failed", at: Date.now(), message: `HTTP ${response.status}` });
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === 0) continue;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  record(source, { status: "failed", at: Date.now(), message });
  throw lastError instanceof MarketUpstreamError
    ? lastError
    : new MarketUpstreamError(source, "upstreamError", `${source} request failed: ${message}`);
}

export async function providerFetchJson<T>(source: MarketSource, url: string, init?: RequestInit): Promise<T> {
  const response = await providerFetch(source, url, init);
  if (!response.ok) {
    throw new MarketUpstreamError(
      source,
      response.status === 404 ? "notFound" : "upstreamError",
      `${source} responded ${response.status} for ${new URL(url).pathname}`,
    );
  }
  const { content } = await readTextWithLimit(source, response, MAX_JSON_BYTES, `response for ${new URL(url).pathname}`);
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new MarketUpstreamError(source, "upstreamBadResponse", `${source} returned invalid JSON for ${new URL(url).pathname}`);
  }
}