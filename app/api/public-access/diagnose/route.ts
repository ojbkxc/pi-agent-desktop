import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { NextResponse } from "next/server";
import { resolveCloudflaredBinary } from "@/lib/public-access/binary";
import { verifyPublicGateway } from "@/lib/public-access/gateway";
import {
  readCloudflareTunnelToken,
  readPublicAccessConfig,
  type PublicAccessConfig,
} from "@/lib/public-access/settings";
import { networkProxyStatus, resolveOutboundProxyUrl } from "@/lib/network-proxy";
import { isLocalRequest } from "@/lib/remote-access";
import { isApiRequestAllowed } from "@/lib/request-security";

/**
 * POST /api/public-access/diagnose —— 「检查配置」按钮的服务端一半。
 *
 * 只在本机可用（开洞是本机上的决定，诊断也一样），只做只读检查：不碰隧道管理器、
 * 不启动/停止 cloudflared，任何一项失败都只是返回一条 failed 结果。
 *
 * 检查项（id 稳定，界面按 id 本地化）：
 *   binary —— cloudflared 能否定位（lib/public-access/binary.ts）
 *   proxy  —— 设置里生效的代理能否建立 TCP 连接（直连/未配置判 skipped）
 *   token  —— 命名隧道的 Token 是否是 cloudflared 认得的凭据（只解出隧道 id）
 *   dns    —— 公网域名能否解析（customUrl 优先，其次运行期 origin）
 *   origin —— 隧道在线时，公网 origin 的 /health 是否回到本进程
 *
 * 安全约定：info 只放安全的机器值（来源、地址、隧道 id、去掉凭据的代理 URL），
 * 原始错误只进 error 字段 —— 界面把 error 放 title，不直接当主文案（见 fork-public-access）。
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const DNS_TIMEOUT_MS = 3_000;
const PROXY_TIMEOUT_MS = 3_000;

type DiagnoseCheckId = "binary" | "proxy" | "token" | "dns" | "origin";
type DiagnoseCheckStatus = "ok" | "failed" | "skipped";

interface DiagnoseCheck {
  id: DiagnoseCheckId;
  status: DiagnoseCheckStatus;
  /** 可安全展示的机器值（来源、地址、隧道 id、剥掉凭据的代理 URL）。 */
  info?: string;
  /** 原始失败信息；界面只作 title/调试，不直接当主文案。 */
  error?: string;
  durationMs?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 让一段不响应 signal 的 Promise（dns.lookup）有界；计时器 unref，不拖住进程退出。 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function checkBinary(): DiagnoseCheck {
  const binary = resolveCloudflaredBinary();
  return binary
    ? { id: "binary", status: "ok", info: binary.source }
    : { id: "binary", status: "failed", error: "cloudflared was not found (env / user / vendor / PATH)" };
}

/** 代理可达性：只做 TCP 连接证明「这个代理地址有东西在听」，不验证它能否转发。 */
function probeTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => finish(new Error(`Connection timed out after ${timeoutMs} ms`)));
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
  });
}

async function checkProxy(): Promise<DiagnoseCheck> {
  const startedAt = Date.now();
  try {
    const status = await networkProxyStatus();
    if (status.mode === "direct") {
      return { id: "proxy", status: "skipped", info: "direct" };
    }
    if (!status.activeProxy) {
      return {
        id: "proxy",
        status: "skipped",
        info: status.mode === "system" ? "system: no proxy detected" : "manual: no proxy url",
      };
    }
    let url: URL;
    try {
      url = new URL(status.activeProxy);
    } catch {
      return { id: "proxy", status: "failed", error: "The saved proxy URL is not a valid URL" };
    }
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const host = url.hostname.replace(/^\[|\]$/g, "");
    await probeTcp(host, port, PROXY_TIMEOUT_MS);
    return { id: "proxy", status: "ok", info: status.activeProxy, durationMs: Date.now() - startedAt };
  } catch (error) {
    return { id: "proxy", status: "failed", error: messageOf(error), durationMs: Date.now() - startedAt };
  }
}

function checkToken(config: PublicAccessConfig): DiagnoseCheck {
  if (config.mode !== "named") return { id: "token", status: "skipped", info: "quick tunnel has no token" };
  if (!config.token) return { id: "token", status: "failed", error: "No tunnel token is saved" };
  const credential = readCloudflareTunnelToken(config.token);
  if (!credential) return { id: "token", status: "failed", error: "The saved token is not a cloudflared credential" };
  return { id: "token", status: "ok", info: credential.tunnelId };
}

function hostnameOf(value: string): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}

async function checkDns(config: PublicAccessConfig): Promise<DiagnoseCheck> {
  const hostname = hostnameOf(config.customUrl) ?? hostnameOf(config.origin);
  if (!hostname) return { id: "dns", status: "skipped", info: "no public hostname configured" };
  const startedAt = Date.now();
  try {
    const address = await withTimeout(lookup(hostname), DNS_TIMEOUT_MS, `DNS lookup timed out after ${DNS_TIMEOUT_MS} ms`);
    return {
      id: "dns",
      status: "ok",
      info: `${hostname} → ${address.address}`,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return { id: "dns", status: "failed", info: hostname, error: messageOf(error), durationMs: Date.now() - startedAt };
  }
}

async function checkOrigin(config: PublicAccessConfig): Promise<DiagnoseCheck> {
  if (!config.origin) return { id: "origin", status: "skipped", info: "tunnel is not online" };
  const startedAt = Date.now();
  // **与连接器同一条出网路径**：连接器走代理桥，探针也必须走 —— 否则「隧道其实通了、
  // 探针假失败」会让用户按提示去拆一个本来正常的隧道。
  const reachable = await verifyPublicGateway(config.origin, undefined, {
    proxyUrl: resolveOutboundProxyUrl(),
  });
  return reachable
    ? { id: "origin", status: "ok", info: config.origin, durationMs: Date.now() - startedAt }
    : {
        id: "origin",
        status: "failed",
        info: config.origin,
        error: "The public address did not reach this process",
        durationMs: Date.now() - startedAt,
      };
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }
  if (!isLocalRequest(req)) {
    return NextResponse.json(
      { error: "Diagnostics can only be run on this computer." },
      { status: 403, headers: NO_STORE },
    );
  }
  const config = readPublicAccessConfig();
  const checks = await Promise.all([
    Promise.resolve(checkBinary()),
    checkProxy(),
    Promise.resolve(checkToken(config)),
    checkDns(config),
    checkOrigin(config),
  ]);
  return NextResponse.json({ checks }, { headers: NO_STORE });
}
