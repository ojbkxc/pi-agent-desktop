/**
 * 本进程的身份与「公网是否真的回到我这儿」的验证（移植自 cc-haha 的
 * src/server/services/remoteAccessConnectivity.ts，去掉它那套网关记录）。
 *
 * 隧道起来之后，仅凭日志里的地址不能确定公网流量到了**这台**机器 —— DNS、缓存、
 * 另一台机器上的同名隧道都可能让地址可达却不是我们。所以 /health 回一个本进程
 * 随机生成的 id，验证方拿公网地址去取，比对上了才算数。
 *
 * **探针必须与连接器同一条出网路径**：连接器现在可以走代理桥（见
 * lib/public-access/cloudflare-proxy.ts），所以当 manager 知道有代理时，探针也经
 * undici 的 `ProxyAgent` 走同一个代理；只有直连模式才用显式直连 dispatcher。
 * 两者分叉会造成「隧道其实通了，探针却假失败 → 误判 network → 拆隧道重建」的老问题。
 */
import { randomUUID } from "node:crypto";
import * as undici from "undici";
import { stripProxyCredentials } from "../network-proxy.ts";

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

export type GatewayVerifyOptions = {
  /**
   * 与连接器同路径：有代理桥时传代理 URL，探针也经 `ProxyAgent` 走代理。
   * 带凭据的 URL 只用于构造 `Proxy-Authorization`（`stripProxyCredentials` + `token`），
   * 不会出现在任何日志或状态里。
   */
  proxyUrl?: string | null;
  /** 注入 fetch（单测断言 dispatcher 用）；缺省用 undici 包自己的 fetch。 */
  fetch?: typeof undici.fetch;
};

/**
 * 由代理 URL 造一个 `ProxyAgent`。凭据从 URL 的 userinfo 读出，转成
 * `Proxy-Authorization: Basic …` 放进 `token`，而 `uri` 用剥掉凭据的地址 ——
 * 这样即便这个 dispatcher 的 URI 被误打印，也不会泄露口令（口令只在本函数内出现）。
 */
function createProxyDispatcher(proxyUrl: string): undici.Dispatcher {
  const parsed = new URL(proxyUrl);
  const options: { uri: string; token?: string } = { uri: stripProxyCredentials(proxyUrl) };
  if (parsed.username || parsed.password) {
    const credentials = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
    options.token = `Basic ${Buffer.from(credentials).toString("base64")}`;
  }
  return new undici.ProxyAgent(options);
}

/**
 * 取公网 origin 的 /health，要求 status=ok 且 gatewayId 等于本进程 id。
 * 任何异常（超时、重定向、非 JSON、body 过大）都算失败。
 *
 * dispatcher 的选择：
 *   - 传了 `proxyUrl`（manager 有代理桥时）→ 新建 `ProxyAgent` 走代理，用完即关；
 *   - 否则 → 模块级直连 `Agent`（忽略环境变量与全局 dispatcher）。
 * 显式传 dispatcher 是为了不被 manual 代理模式下被替换的 `globalThis.fetch` /
 * `undici.setGlobalDispatcher` 带偏：探针只认「与连接器一致的那条路」。
 */
export async function verifyPublicGateway(
  origin: string,
  expectedId = gatewayId(),
  options: GatewayVerifyOptions = {},
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL("/health", origin);
  } catch {
    return false;
  }

  const owned = options.proxyUrl ? createProxyDispatcher(options.proxyUrl) : null;
  const dispatcher = owned ?? directDispatcher;
  const fetchImpl = options.fetch ?? undici.fetch;
  try {
    const response = await fetchImpl(url, {
      redirect: "manual",
      cache: "no-store",
      dispatcher,
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
  } finally {
    if (owned) {
      try { await owned.close(); } catch { /* 关闭失败不影响判定结果。 */ }
    }
  }
}
