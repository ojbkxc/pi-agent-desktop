/**
 * 本进程的身份与「公网是否真的回到我这儿」的验证（移植自 cc-haha 的
 * src/server/services/remoteAccessConnectivity.ts，去掉它那套网关记录）。
 *
 * 隧道起来之后，仅凭日志里的地址不能确定公网流量到了**这台**机器 —— DNS、缓存、
 * 另一台机器上的同名隧道都可能让地址可达却不是我们。所以 /health 回一个本进程
 * 随机生成的 id，验证方拿公网地址去取，比对上了才算数。
 *
 * 探针的出网路径必须与 cloudflared 一致（见 verifyPublicGateway 的注释）：
 * 连接器被剥掉代理 env 永远直连，探针走代理就会与实际路径分叉。
 */
import { randomUUID } from "node:crypto";
import * as undici from "undici";

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
 * 探针专用的直连 dispatcher：不读 *_proxy 环境变量（那是 EnvHttpProxyAgent 的活），
 * 也不读进程级全局 dispatcher（undici.setGlobalDispatcher 只影响不显式传
 * dispatcher 的调用）。模块级单例——探针是低频调用，无需每次新建。
 */
const directDispatcher = new undici.Agent();

/**
 * 取公网 origin 的 /health，要求 status=ok 且 gatewayId 等于本进程 id。
 * 任何异常（超时、重定向、非 JSON、body 过大）都算失败。
 *
 * 为什么固定用 undici 包自己的 fetch + 显式直连 dispatcher，而不是 globalThis.fetch：
 *   - manual 代理模式下 applyGlobalFetchForProxy（lib/http-dispatcher.ts）会把
 *     globalThis.fetch 换成读 EnvHttpProxyAgent 的 undici.fetch——走代理；
 *   - installHttpDispatcher 还会 undici.setGlobalDispatcher(EnvHttpProxyAgent)，
 *     同样影响所有不显式传 dispatcher 的 undici.fetch 调用；
 *   - 而 cloudflareProcessEnvironment（lib/public-access/tunnel.ts）剥掉了
 *     *_proxy，连接器永远直连出网。
 * 于是代理坏/不通时隧道其实是通的（cloudflared 直连），探针却会假失败 → 误判
 * network → 拆隧道重建，永远连不上。探针必须与连接器同路径：直连。
 *
 * 与 cc-haha 的有意分歧：cc-haha 用 getNetworkProxyFetchOptions 让探针走代理，
 * 因为它的 cloudflared 也走代理桥（cloudflareProxy）；pi 没有代理桥，连接器
 * 直连，所以探针必须直连。
 */
export async function verifyPublicGateway(origin: string, expectedId = gatewayId()): Promise<boolean> {
  let url: URL;
  try {
    url = new URL("/health", origin);
  } catch {
    return false;
  }
  try {
    const response = await undici.fetch(url, {
      redirect: "manual",
      cache: "no-store",
      dispatcher: directDispatcher,
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
