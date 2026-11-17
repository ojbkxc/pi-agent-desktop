/**
 * cloudflared 的**代理桥**（移植自 cc-haha 的
 * `desktop/electron/services/cloudflareProxy.ts`）。
 *
 * 为什么需要它：cloudflared 2026.x 的两条出网路径都**忽略** `HTTPS_PROXY` ——
 * 一是边缘节点的 TCP 拨号（`regionN.v2.argotunnel.com:7844`），二是 Quick Tunnel
 * 的 provisioning（HTTPS 到 `api.trycloudflare.com`）。在「只有代理能出网」的环境里，
 * 连接器要么根本起不来、要么注册后立刻被边缘断开，而 manager 会据此判定 network
 * 反复拆建，永远 online 不了。
 *
 * 做法：在本地回环起两组 listener，把 cloudflared 的两条出网路径都强制经用户选的
 * HTTP 代理出去，再由 `tunnel.ts` 通过 `--edge` / `--quick-service` 把本地地址交给它：
 *   - **edge bridge**：接收 cloudflared 发往本地端口的原始 TCP，经代理 CONNECT 到
 *     `regionN.v2.argotunnel.com:7844` 后双向 pipe。TLS 仍在 cloudflared 内（SNI
 *     `h2.cftunnel.com`），桥只搬字节，不能解析。
 *   - **quick-service bridge**：本地 `http.Server` 接收 Quick Tunnel 的 provisioning
 *     请求，经代理 CONNECT + TLS 到 `api.trycloudflare.com:443` 后转发并回写。带一个
 *     `randomBytes(24)` 的随机路径前缀，挡住本机其它进程对这条本地通道的乱用。
 *
 * 代理协议：支持 `http:`（明文 CONNECT 隧道）与 `https:`（对代理本身再起 TLS），与
 * cc-haha 一致；`socks:` / PAC 等明确拒绝（返回清楚的 reason `unsupported_proxy_protocol`），
 * 因为 CONNECT 握手与 undici 的 ProxyAgent 都不支持它们。
 *
 * **凭据只进握手，绝不外泄**：代理 URL 的 userinfo 只用于构造 `Proxy-Authorization:
 * Basic`；完整带凭据的 URL 既不写进 cloudflared 的 argv / 环境变量，也不出现在任何
 * 诊断事件的文案里（事件只报 proxyHost / proxyPort / proxyProtocol）。
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { PublicAccessDiagnosticWriter } from "./diagnostics.ts";

const LOOPBACK_HOST = "127.0.0.1";
const EDGE_HOSTS = ["region1.v2.argotunnel.com", "region2.v2.argotunnel.com"] as const;
const QUICK_SERVICE_HOST = "api.trycloudflare.com";
/** 代理 CONNECT 握手的总超时：代理不响时应尽快失败，而不是把 cloudflared 拖到它自己的超时。 */
const CONNECT_TIMEOUT_MS = 10_000;
/** Quick Tunnel provisioning 请求的超时。 */
const QUICK_REQUEST_TIMEOUT_MS = 15_000;
const MAX_QUICK_REQUEST_BYTES = 4096;
const MAX_QUICK_RESPONSE_BYTES = 1024 * 1024;
const MAX_CONNECT_HEADER_BYTES = 32 * 1024;
/** 四条本地 edge 监听：命名隧道默认会开多条连接，各自的本地端口保证它们都走代理。 */
const EDGE_LISTENER_COUNT = 4;

export type CloudflareProxyTransport = {
  /** 交给 cloudflared 的 `--edge` 地址（`127.0.0.1:<port>`），每个都是一条独立的代理出口。 */
  edgeAddresses: string[];
  /** 交给 cloudflared 的 `--quick-service` 基地址（带随机路径前缀，仅 quick 模式用）。 */
  quickServiceUrl: string;
  /** 幂等关闭：销毁所有 socket 并关掉本地监听。重复调用返回同一个 Promise。 */
  stop(): Promise<void>;
};

export type CloudflareProxyOptions = {
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** 为确定性本地 TLS 夹具或企业 CA 追加信任根。 */
  ca?: tls.ConnectionOptions["ca"];
  /** 诊断写入器；manager 传入的那个会补 attemptId 并用 secrets 脱敏。 */
  onDiagnostic?: PublicAccessDiagnosticWriter;
};

/** 代理协议不合法时抛出；`reason` 供诊断事件与设置页展示（不含凭据）。 */
export class CloudflareProxyError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CloudflareProxyError";
    this.reason = reason;
  }
}

/**
 * 起代理桥。成功 = 四条 edge 监听 + 一条 quick-service 监听都已 listen；
 * 失败会先把自己已经起来的监听全部关掉再抛（不留半个桥）。
 */
export async function startCloudflareProxyTransport(
  proxyUrl: string,
  options: CloudflareProxyOptions = {},
): Promise<CloudflareProxyTransport> {
  const startedAt = Date.now();
  const diagnostic: PublicAccessDiagnosticWriter = (event) => {
    try { options.onDiagnostic?.(event); } catch { /* 诊断是旁路，绝不能把桥带崩。 */ }
  };
  let proxy: URL;
  try {
    proxy = parseProxyUrl(proxyUrl);
  } catch (error) {
    diagnostic({
      stage: "proxy_transport",
      outcome: "failed",
      reason: "invalid_proxy_url",
      error,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }

  const controller = new AbortController();
  const servers: Array<net.Server | http.Server> = [];
  const sockets = new Set<Duplex>();
  const quickPath = `/${randomBytes(24).toString("hex")}`;
  let stopping: Promise<void> | null = null;
  let starting = true;

  const track = <T extends Duplex>(socket: T): T => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    // 请求方先断开后，拨号中的 socket 仍可能报错；始终挂着 error 监听，避免未捕获异常。
    socket.on("error", () => {});
    return socket;
  };

  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    controller.abort();
    options.signal?.removeEventListener("abort", abort);
    for (const socket of sockets) socket.destroy();
    stopping = Promise.all(servers.map(closeServer)).then(() => {});
    return stopping;
  };

  const abort = () => {
    controller.abort();
    // 启动中的 listen 回调先跑完再关，否则可能在部分运行时里丢掉回调、卡住启动。
    if (!starting) void stop();
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  const connect = (host: string, port: number, signal: AbortSignal) =>
    connectProxy(
      proxy,
      host,
      port,
      signal,
      options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
      track,
      options.ca,
      diagnostic,
    );

  try {
    throwIfAborted(options.signal);
    const edgeAddresses: string[] = [];
    // 四个不同的本地地址保住命名隧道的多条连接；失败时也只会在这几条本地入口上重试，
    // 绝不直连回公网（否则等于绕过用户的代理）。
    for (let index = 0; index < EDGE_LISTENER_COUNT; index += 1) {
      const edgeHost = EDGE_HOSTS[index % EDGE_HOSTS.length]!;
      const server = net.createServer({ pauseOnConnect: true }, (client) => {
        track(client);
        const attempt = new AbortController();
        const cancel = () => attempt.abort();
        const signal = AbortSignal.any([controller.signal, attempt.signal]);
        client.once("close", cancel);
        void connect(edgeHost, 7844, signal).then((upstream) => {
          if (signal.aborted || client.destroyed) {
            upstream.destroy();
            client.destroy();
            return;
          }
          client.once("error", () => upstream.destroy());
          client.once("close", () => upstream.destroy());
          upstream.once("error", () => client.destroy());
          upstream.once("close", () => {
            if (!upstream.readableEnded) client.destroy();
          });
          upstream.pipe(client);
          client.pipe(upstream);
          client.resume();
        }).catch(() => client.destroy());
      });
      servers.push(server);
      edgeAddresses.push(await listen(server));
      throwIfAborted(controller.signal);
    }

    const quickServer = http.createServer((request, response) => {
      void handleQuickRequest(request, response);
    });
    quickServer.headersTimeout = 5_000;
    quickServer.requestTimeout = 5_000;
    quickServer.on("connection", track);
    quickServer.on("clientError", (_error, socket) => socket.destroy());
    servers.push(quickServer);
    const quickAddress = await listen(quickServer);
    throwIfAborted(controller.signal);

    async function handleQuickRequest(request: http.IncomingMessage, response: http.ServerResponse) {
      // 随机路径前缀 + 只认 POST + Host 必须是本地监听 + 不许带 Origin：把本地通道
      // 收窄成「只有 cloudflared 那条 provisioning 请求」能用。
      if (
        request.method !== "POST"
        || request.url !== `${quickPath}/tunnel`
        || request.headers.host !== quickAddress
        || request.headers.origin
      ) {
        response.writeHead(404, { Connection: "close" });
        response.end();
        return;
      }
      const attempt = new AbortController();
      const requestStartedAt = Date.now();
      let timedOut = false;
      const cancel = () => attempt.abort();
      const timeout = setTimeout(() => { timedOut = true; cancel(); }, options.requestTimeoutMs ?? QUICK_REQUEST_TIMEOUT_MS);
      const signal = AbortSignal.any([controller.signal, attempt.signal]);
      request.once("aborted", cancel);
      response.once("close", () => {
        if (!response.writableFinished) cancel();
      });
      let secureSocket: tls.TLSSocket | undefined;
      let agent: http.Agent | undefined;
      let step = "read_request";
      try {
        const body = await readLimitedBody(request, MAX_QUICK_REQUEST_BYTES, signal);
        step = "proxy_connect";
        const socket = await connect(QUICK_SERVICE_HOST, 443, signal);
        throwIfAborted(signal);
        step = "quick_tls";
        secureSocket = track(tls.connect({
          socket,
          // 不支持 socket 升级的运行时必须在回环处失败，绝不能悄悄对公网 SNI 直连。
          host: LOOPBACK_HOST,
          port: 1,
          servername: QUICK_SERVICE_HOST,
          rejectUnauthorized: true,
          ...(options.ca ? { ca: options.ca } : {}),
        }));
        secureSocket.once("secureConnect", () => { step = "quick_request"; });
        agent = new ConnectedHttpAgent(secureSocket);
        const result = await requestQuickService(agent, body, request.headers["user-agent"], signal);
        const ok = result.status >= 200 && result.status < 300;
        diagnostic({
          stage: "quick_provisioning",
          outcome: ok ? "succeeded" : "failed",
          reason: ok ? "http_success" : "http_status",
          durationMs: Date.now() - requestStartedAt,
          details: { status: result.status, targetHost: QUICK_SERVICE_HOST, targetPort: 443 },
        });
        if (response.destroyed) return;
        response.writeHead(result.status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          Connection: "close",
        });
        response.end(result.body);
      } catch (error) {
        diagnostic({
          stage: "quick_provisioning",
          outcome: signal.aborted && !timedOut ? "cancelled" : "failed",
          reason: timedOut ? "request_timeout" : signal.aborted ? "request_cancelled" : "request_failed",
          error,
          durationMs: Date.now() - requestStartedAt,
          details: { step, timeoutMs: options.requestTimeoutMs ?? QUICK_REQUEST_TIMEOUT_MS, targetHost: QUICK_SERVICE_HOST, targetPort: 443 },
        });
        // 绝不回显代理 URL、凭据、上游响应或 TLS 错误；只给一个中性的失败体。
        if (!response.destroyed) {
          response.writeHead(signal.aborted ? 504 : 502, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            Connection: "close",
          });
          response.end(JSON.stringify({ success: false, errors: [{ message: "Cloudflare proxy connection failed" }] }));
        }
      } finally {
        clearTimeout(timeout);
        request.off("aborted", cancel);
        agent?.destroy();
        secureSocket?.destroy();
      }
    }

    starting = false;
    return { edgeAddresses, quickServiceUrl: `http://${quickAddress}${quickPath}`, stop };
  } catch (error) {
    diagnostic({
      stage: "proxy_transport",
      outcome: controller.signal.aborted ? "cancelled" : "failed",
      reason: "listener_setup_failed",
      error,
      durationMs: Date.now() - startedAt,
    });
    starting = false;
    await stop();
    throw error;
  }
}

/** 只接受 http:/https: 的代理 URL；其余（socks/PAC/带 query 或 hash）明确拒绝。 */
function parseProxyUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CloudflareProxyError("invalid_proxy_url", "Cloudflare requires a valid HTTP or HTTPS proxy");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CloudflareProxyError("unsupported_proxy_protocol", "Cloudflare requires a valid HTTP or HTTPS proxy");
  }
  if (!url.hostname || url.hash || url.search) {
    throw new CloudflareProxyError("invalid_proxy_url", "Cloudflare requires a valid HTTP or HTTPS proxy");
  }
  try {
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    throw new CloudflareProxyError("invalid_proxy_url", "Cloudflare requires a valid HTTP or HTTPS proxy");
  }
  return url;
}

/**
 * 经代理 CONNECT 到 `targetHost:targetPort`，握手成功返回一条已就绪的 socket。
 * 代理凭据只用于 `Proxy-Authorization` 头；读到的多余字节（紧跟握手的应用数据）
 * 会 unshift 回 socket，绝不丢失。
 */
function connectProxy(
  proxy: URL,
  targetHost: string,
  targetPort: number,
  signal: AbortSignal,
  timeoutMs: number,
  track: <T extends Duplex>(socket: T) => T,
  ca: tls.ConnectionOptions["ca"],
  diagnostic: PublicAccessDiagnosticWriter,
): Promise<net.Socket> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      diagnostic({
        stage: "proxy_connect", outcome: "cancelled", reason: "request_cancelled", durationMs: Date.now() - startedAt,
        details: { targetHost, targetPort },
      });
      reject(new CloudflareProxyError("request_cancelled", "Cloudflare proxy connection cancelled"));
      return;
    }
    const authority = `${targetHost}:${targetPort}`;
    const headers = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, "Proxy-Connection: keep-alive"];
    if (proxy.username || proxy.password) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers.push(`Proxy-Authorization: Basic ${Buffer.from(credentials).toString("base64")}`);
    }
    const host = proxy.hostname.replace(/^\[|\]$/g, "");
    const port = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
    const secure = proxy.protocol === "https:";
    let step = secure ? "proxy_tls" : "proxy_tcp";
    let settled = false;
    const socket = track(secure
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ...(ca ? { ca } : {}) })
      : net.connect({ host, port }));
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      socket.off("data", onData);
      socket.off("error", socketError);
      socket.off("end", socketClosed);
      socket.off("close", socketClosed);
    };
    const fail = (reason: string, error?: unknown, status?: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      diagnostic({
        stage: "proxy_connect",
        outcome: signal.aborted ? "cancelled" : "failed",
        reason,
        error,
        durationMs: Date.now() - startedAt,
        details: {
          step,
          targetHost,
          targetPort,
          proxyHost: host,
          proxyPort: port,
          proxyProtocol: proxy.protocol,
          timeoutMs,
          ...(status !== undefined ? { status } : {}),
        },
      });
      reject(new CloudflareProxyError(reason, "Cloudflare proxy connection failed", error === undefined ? undefined : { cause: error }));
    };
    const socketError = (error: Error) => fail("proxy_socket_error", error);
    const socketClosed = () => fail("proxy_closed");
    const cancel = () => fail("request_cancelled");
    const timeout = setTimeout(() => fail("connect_timeout"), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const marker = buffered.indexOf("\r\n\r\n");
      if (marker < 0) {
        if (buffered.length > MAX_CONNECT_HEADER_BYTES) fail("connect_headers_too_large");
        return;
      }
      if (marker + 4 > MAX_CONNECT_HEADER_BYTES) {
        fail("connect_headers_too_large");
        return;
      }
      const statusLine = buffered.toString("latin1", 0, marker).split("\r\n", 1)[0] ?? "";
      const status = Number(statusLine.match(/^HTTP\/1\.[01][ \t]+(\d{3})(?:[ \t]|$)/)?.[1]);
      if (!Number.isFinite(status)) {
        fail("invalid_connect_response");
        return;
      }
      if (status < 200 || status >= 300 || signal.aborted) {
        fail(signal.aborted ? "request_cancelled" : "http_connect_rejected", undefined, status);
        return;
      }
      cleanup();
      settled = true;
      diagnostic({
        stage: "proxy_connect", outcome: "succeeded", reason: "connect_established", durationMs: Date.now() - startedAt,
        details: { targetHost, targetPort, status },
      });
      socket.pause();
      const rest = buffered.subarray(marker + 4);
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    };
    signal.addEventListener("abort", cancel, { once: true });
    socket.on("data", onData);
    socket.once("error", socketError);
    socket.once("end", socketClosed);
    socket.once("close", socketClosed);
    socket.once(secure ? "secureConnect" : "connect", () => {
      step = "http_connect";
      if (!signal.aborted && !socket.destroyed) socket.write(`${headers.join("\r\n")}\r\n\r\n`);
    });
  });
}

/** 复用一个已建立的 TLS socket 的 Agent（请求永远走这条经代理的管道，绝不新建直连）。 */
class ConnectedHttpAgent extends http.Agent {
  private readonly tunnelSocket: tls.TLSSocket;
  constructor(socket: tls.TLSSocket) {
    super({ keepAlive: false });
    this.tunnelSocket = socket;
  }
  createConnection(): tls.TLSSocket { return this.tunnelSocket; }
}

function requestQuickService(
  agent: http.Agent,
  body: Buffer,
  userAgent: string | undefined,
  signal: AbortSignal,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    // TLS 已经经 CONNECT 建好。host/port 故意指向回环死端口：不支持自定义 Agent
    // 的运行时必须在本地失败，而不是悄悄绕过代理去连公网。
    const request = http.request({
      hostname: LOOPBACK_HOST,
      port: 1,
      path: "/tunnel",
      method: "POST",
      headers: {
        Host: QUICK_SERVICE_HOST,
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
        ...(userAgent ? { "User-Agent": userAgent } : {}),
      },
      agent,
      signal,
    }, (response) => {
      void readLimitedBody(response, MAX_QUICK_RESPONSE_BYTES, signal).then((result) => {
        resolve({ status: response.statusCode ?? 502, body: result });
      }, reject);
    });
    request.once("error", reject);
    request.end(body);
  });
}

async function readLimitedBody(stream: http.IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  const cancel = () => stream.destroy(new Error("Cloudflare proxy request cancelled"));
  signal.addEventListener("abort", cancel, { once: true });
  try {
    throwIfAborted(signal);
    let length = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += data.length;
      if (length > limit) throw new CloudflareProxyError("request_too_large", "Cloudflare proxy request exceeded maximum size");
      chunks.push(data);
    }
    return Buffer.concat(chunks, length);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function listen(server: net.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new CloudflareProxyError("listener_failed", "Cloudflare proxy listener failed"));
      else resolve(`${LOOPBACK_HOST}:${address.port}`);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  if (server instanceof http.Server) server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CloudflareProxyError("request_cancelled", "Cloudflare proxy connection cancelled");
}
