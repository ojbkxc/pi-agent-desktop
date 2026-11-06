/**
 * 本进程的身份与「公网是否真的回到我这儿」的验证（移植自 cc-haha 的
 * src/server/services/remoteAccessConnectivity.ts，去掉它那套网关记录）。
 *
 * 隧道起来之后，仅凭日志里的地址不能确定公网流量到了**这台**机器 —— DNS、缓存、
 * 另一台机器上的同名隧道都可能让地址可达却不是我们。所以 /health 回一个本进程
 * 随机生成的 id，验证方拿公网地址去取，比对上了才算数。
 */
import { randomUUID } from "node:crypto";

type GatewayGlobal = typeof globalThis & { __piPublicAccessGatewayId?: string };

/** 本进程的网关身份。放 globalThis：dev 热重载不换 id，公网验证才不会莫名失败。 */
export function gatewayId(): string {
  const shared = globalThis as GatewayGlobal;
  shared.__piPublicAccessGatewayId ??= `pi-web-${randomUUID()}`;
  return shared.__piPublicAccessGatewayId;
}

const HEALTH_TIMEOUT_MS = 6_000;
const MAX_HEALTH_BYTES = 4096;

/**
 * 取公网 origin 的 /health，要求 status=ok 且 gatewayId 等于本进程 id。
 * 任何异常（超时、重定向、非 JSON、body 过大）都算失败。
 */
export async function verifyPublicGateway(origin: string, expectedId = gatewayId()): Promise<boolean> {
  let url: URL;
  try {
    url = new URL("/health", origin);
  } catch {
    return false;
  }
  try {
    const response = await fetch(url, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return false;
    if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return false;
    const body = await response.text();
    if (body.length > MAX_HEALTH_BYTES) return false;
    const parsed = JSON.parse(body) as { status?: unknown; gatewayId?: unknown };
    return parsed?.status === "ok" && parsed.gatewayId === expectedId;
  } catch {
    return false;
  }
}
