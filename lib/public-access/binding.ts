/**
 * 固定域名绑定判定（纯函数，单测覆盖）。
 *
 * 命名隧道的入口不来自日志 URL，而是 Cloudflare 推下来的 ingress 规则（见
 * lib/public-access/tunnel.ts 的 readPublishedRoutes）。用户填了自定义域名时，
 * 「绑上了吗」要看推送规则里有没有一条**同时**满足：
 *   1. hostname 覆盖自定义域名（精确 / `*.example.com` 通配 / 空 = catch-all）；
 *   2. service 指向本机网关（reachesGateway 的口径，publishedGatewayOrigin 已实现）。
 *
 * 判定结果进 PublicAccessStatus.domainBinding，供设置页向导展示状态与操作指引；
 * 「timeout」（预算耗尽仍未绑定）由 manager 的轮询预算判定，不在这个纯函数里。
 */
import { publishedGatewayOrigin, type CloudflareTunnelRoute } from "./tunnel.ts";

/** 绑定状态：等待推送 / 已绑定 / 未绑定 / 超时。 */
export type DomainBindingState = "polling" | "bound" | "unbound" | "timeout";
/** 未绑定的原因：只推送了别的域名 / 域名在路由里但没指向本机网关。 */
export type DomainBindingReason = "other-hostnames" | "service-mismatch";

/** PublicAccessStatus.domainBinding 的形状。 */
export interface DomainBindingStatus {
  state: DomainBindingState;
  reason: DomainBindingReason | null;
}

/** classifyDomainBinding 的结论：bound 额外带回可用的公网 origin。 */
export type DomainBindingResult = DomainBindingStatus & { origin?: string };

/**
 * 一条路由的 hostname 是否覆盖自定义域名：空 = catch-all（覆盖一切），
 * `*.example.com` = 通配（只覆盖一层子域，不覆盖 example.com 本身），否则精确匹配。
 * 与 publishedGatewayOrigin 的 preferred 覆盖判定同一口径。
 */
export function routeCoversHostname(route: CloudflareTunnelRoute, hostname: string): boolean {
  const pattern = route.hostname?.toLowerCase();
  if (!pattern) return true;
  return pattern === hostname || (pattern.startsWith("*.") && hostname.endsWith(pattern.slice(1)));
}

/**
 * 把推送的 ingress 规则翻译成绑定判定。`routes` 为 null 表示尚未收到任何推送
 * （polling，超时交给 manager 的预算）；空数组表示推来了空规则表（未绑定）。
 *
 * bound 的判定用 publishedGatewayOrigin(routes, port, customUrl) 的 preferred 分支：
 * 只有自定义域名被某条指向网关的规则覆盖时它才返回 customUrl 本身——否则它会
 * 回落到第一条指向网关的路由（可能是别的域名），所以必须再要求 `origin === customUrl`，
 * 绝不能拿回落结果当「已绑定」。
 */
export function classifyDomainBinding(
  routes: CloudflareTunnelRoute[] | null,
  customUrl: string,
  port: number,
): DomainBindingResult {
  if (!routes) return { state: "polling", reason: null };
  let hostname = "";
  try {
    hostname = new URL(customUrl).hostname.toLowerCase();
  } catch {
    // customUrl 由 settings 层归一化（https origin），这里只做防御。
    return { state: "unbound", reason: "other-hostnames" };
  }
  const origin = publishedGatewayOrigin(routes, port, customUrl);
  if (origin === customUrl) return { state: "bound", reason: null, origin };
  const covered = routes.some((route) => routeCoversHostname(route, hostname));
  return { state: "unbound", reason: covered ? "service-mismatch" : "other-hostnames" };
}
