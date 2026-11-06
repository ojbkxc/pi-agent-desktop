/**
 * cloudflared 连接器（移植自 cc-haha 的 desktop/electron/services/cloudflareTunnel.ts，
 * 去掉代理桥部分）。
 *
 * 职责只有一件：把 cloudflared 拉起来、判断它**真的**连通了、给出公网入口、并且能被可靠地停掉。
 *
 * 「真的连通」有两条同时成立的条件：日志里出现入口地址，**且**出现边缘节点注册成功。
 * 只打印了地址不算数——那可能发生在数据连接建立之前。
 *
 * 命名隧道（named）的入口不来自日志里的 URL，而是 Cloudflare 推下来的 ingress 规则，
 * 所以这里还要解析推送的配置（zerolog 的 Go 转义 + 内层 JSON，两层解析）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCloudflaredBinary } from "./binary.ts";
import { isCloudflareTunnelToken } from "./settings.ts";

export type CloudflareTunnelPhase = "starting" | "registering" | "ready";
export type CloudflareTunnelErrorCode = "runtime" | "network" | "configuration" | "token" | "route";

export class CloudflareTunnelError extends Error {
  readonly code: CloudflareTunnelErrorCode;
  /** 仅供内部恢复用的句柄；绝不进 status 对象。 */
  readonly retryStop?: () => Promise<void>;

  constructor(code: CloudflareTunnelErrorCode, message: string, retryStop?: () => Promise<void>) {
    super(message);
    this.name = "CloudflareTunnelError";
    this.code = code;
    this.retryStop = retryStop;
  }
}

export type CloudflareTunnelOptions = {
  mode: "quick" | "named";
  localPort: number;
  token?: string;
  signal?: AbortSignal;
  onPhase?: (phase: CloudflareTunnelPhase) => void;
};

export type CloudflareTunnelExit = { code: number | null; signal: NodeJS.Signals | null };
/** Cloudflare 推给仪表盘托管隧道的 ingress 规则之一。 */
export type CloudflareTunnelRoute = { hostname?: string; service?: string };
export type CloudflareTunnelRouteWait = { timeoutMs?: number; signal?: AbortSignal };
export type CloudflareTunnel = {
  /** Quick Tunnel 的入口地址；命名隧道的入口由推送的规则决定。 */
  url: string | null;
  publishedRoutes(seen: CloudflareTunnelRoute[] | null, wait?: CloudflareTunnelRouteWait): Promise<CloudflareTunnelRoute[] | null>;
  stop(): Promise<void>;
  onExit(callback: (exit: CloudflareTunnelExit) => void): () => void;
};

export type CloudflareTunnelDependencies = {
  binaryPath?: string;
  spawn?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  stopTimeoutMs?: number;
  temporaryDirectory?: string;
};

const CLOUDFLARE_ENVIRONMENT = /^(?:TUNNEL_|CLOUDFLARED_|NO_AUTOUPDATE$)/i;
const PROXY_ENVIRONMENT = /^(?:https?_proxy|all_proxy|no_proxy)$/i;
const QUICK_URL = /https:\/\/(?!api\.)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com(?![a-z0-9.-])/i;
const LOG_WINDOW_BYTES = 16 * 1024;
const MAX_LOG_LINE_BYTES = 256 * 1024;
/** cloudflared 每次边缘拒绝注册都会打这一行，然后无限重试。 */
const SERVER_REFUSAL = /\bRegister tunnel error from server side\b/;
/** 注册前的第二次拒绝足以排除「偶发边缘抖动」。 */
const TOKEN_REFUSALS = 2;
/** zerolog 的 console writer 用 Go 的 strconv.Quote 打字符串字段。 */
const PUSHED_CONFIGURATION = /\bUpdated to new configuration\b.*?\bconfig=("(?:[^"\\]|\\.)*")/;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;

/**
 * 连接器不许继承他人的代理或 token 设置：剔除 *_proxy / TUNNEL_ / CLOUDFLARED_，
 * 把 HOME 指到本次运行的临时目录，token 只走环境变量（绝不进 argv）。
 */
export function cloudflareProcessEnvironment(
  source: NodeJS.ProcessEnv,
  directory: string,
  token?: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(environment)) {
    if (PROXY_ENVIRONMENT.test(key) || CLOUDFLARE_ENVIRONMENT.test(key)) delete environment[key];
  }
  environment.HOME = directory;
  environment.USERPROFILE = directory;
  environment.XDG_CONFIG_HOME = directory;
  environment.NO_AUTOUPDATE = "true";
  if (token) environment.TUNNEL_TOKEN = token;
  return environment;
}

function aborted(): Error {
  const error = new Error("Cloudflare connection cancelled");
  error.name = "AbortError";
  return error;
}

function validateOptions(options: CloudflareTunnelOptions): void {
  if ((options.mode !== "quick" && options.mode !== "named")
    || !Number.isInteger(options.localPort) || options.localPort < 1024 || options.localPort > 65535) {
    throw new CloudflareTunnelError("configuration", "Invalid Cloudflare connection configuration");
  }
  if (options.mode === "named" && !(isCloudflareTunnelToken(options.token) && options.token.length > 0)) {
    throw new CloudflareTunnelError("token", "A Cloudflare Tunnel Token is required");
  }
}

function phase(options: CloudflareTunnelOptions, value: CloudflareTunnelPhase): void {
  try { options.onPhase?.(value); } catch { /* 状态观察者不能打断清理。 */ }
}

/** 一条连接器日志里的 ingress 规则（配置由 Cloudflare 推下来）。 */
export function readPublishedRoutes(line: string): CloudflareTunnelRoute[] | null {
  const quoted = line.match(PUSHED_CONFIGURATION)?.[1];
  if (!quoted) return null;
  try {
    const configuration: unknown = JSON.parse(JSON.parse(quoted) as string);
    const ingress = configuration && typeof configuration === "object"
      ? (configuration as { ingress?: unknown }).ingress
      : undefined;
    if (!Array.isArray(ingress)) return null;
    return ingress
      .filter((rule): rule is Record<string, unknown> => Boolean(rule) && typeof rule === "object")
      .map((rule) => ({
        ...(typeof rule.hostname === "string" && rule.hostname ? { hostname: rule.hostname } : {}),
        ...(typeof rule.service === "string" ? { service: rule.service } : {}),
      }));
  } catch {
    return null;
  }
}

function reachesGateway(route: CloudflareTunnelRoute, localPort: number): boolean {
  try {
    const service = new URL(route.service ?? "");
    return service.protocol === "http:"
      && ["127.0.0.1", "localhost"].includes(service.hostname)
      && Number(service.port) === localPort;
  } catch {
    return false;
  }
}

function hostnameOrigin(hostname: string): string | null {
  try {
    const url = new URL(`https://${hostname}`);
    return url.hostname === hostname.toLowerCase() && !url.port ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * 推下来的规则里，指向本机明文网关的那个 HTTPS origin。
 * `preferred`（用户填的自定义域名）被某条规则覆盖时优先返回它，通配与 catch-all 也算覆盖。
 */
export function publishedGatewayOrigin(
  routes: CloudflareTunnelRoute[],
  localPort: number,
  preferred?: string,
): string | null {
  const gatewayRoutes = routes.filter((route) => reachesGateway(route, localPort));
  if (preferred) {
    const host = new URL(preferred).hostname;
    if (gatewayRoutes.some((route) => {
      const pattern = route.hostname?.toLowerCase();
      return !pattern || pattern === host || (pattern.startsWith("*.") && host.endsWith(pattern.slice(1)));
    })) return preferred;
  }
  for (const route of gatewayRoutes) {
    const origin = route.hostname && !route.hostname.includes("*") ? hostnameOrigin(route.hostname) : null;
    if (origin) return origin;
  }
  return null;
}

/**
 * 起连接器。就绪 = 「边缘注册成功」且（quick 时）「入口地址已打印」；
 * 公网是否真的回到本机由 manager 另行验证（见 lib/public-access/gateway.ts）。
 */
export async function startCloudflareTunnel(
  options: CloudflareTunnelOptions,
  dependencies: CloudflareTunnelDependencies = {},
): Promise<CloudflareTunnel> {
  validateOptions(options);
  if (options.signal?.aborted) throw aborted();
  const binary = dependencies.binaryPath ?? resolveCloudflaredBinary(dependencies.env ?? process.env, dependencies.cwd)?.path;
  if (!binary) throw new CloudflareTunnelError("runtime", "The Cloudflare connector is unavailable");
  try {
    await access(binary, constants.X_OK);
  } catch {
    throw new CloudflareTunnelError("runtime", "The Cloudflare connector is unavailable");
  }
  if (options.signal?.aborted) throw aborted();

  const directory = await mkdtemp(path.join(dependencies.temporaryDirectory ?? os.tmpdir(), "pi-web-cloudflared-"));
  let child: ChildProcess | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let exited = false;
  let stopping = false;
  let exitInfo: CloudflareTunnelExit | undefined;
  let startupSettled = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveStartup!: (url: string | null) => void;
  let rejectStartup!: (error: Error) => void;
  let resolveExit!: () => void;
  const exitCallbacks = new Set<(exit: CloudflareTunnelExit) => void>();
  const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
  const startup = new Promise<string | null>((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject; });
  // spawn 失败可能发生在 startup 被 await 之前。
  void startup.catch(() => {});

  const reject = (error: Error) => {
    if (startupSettled) return;
    startupSettled = true;
    clearTimeout(startupTimer);
    rejectStartup(error);
  };

  const cleanup = () => {
    cleanupPromise ??= (async () => {
      clearTimeout(startupTimer);
      options.signal?.removeEventListener("abort", onAbort);
      await rm(directory, { recursive: true, force: true });
    })();
    return cleanupPromise;
  };

  const waitForExit = async (milliseconds: number): Promise<boolean> => {
    if (exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exit, new Promise<void>((resolve) => { timer = setTimeout(resolve, milliseconds); })]);
      return exited;
    } finally {
      clearTimeout(timer);
    }
  };

  const stop = () => {
    if (stopPromise) return stopPromise;
    const operation = (async () => {
      stopping = true;
      reject(aborted());
      if (child && !exited) {
        try { child.kill("SIGTERM"); } catch { /* 宽限期过后再升级。 */ }
        if (!await waitForExit(dependencies.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)) {
          try { child.kill("SIGKILL"); } catch { /* 下面核对是否真的退出。 */ }
          if (!await waitForExit(dependencies.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)) {
            throw new CloudflareTunnelError("runtime", "Cloudflare connector shutdown could not be confirmed", stop);
          }
        }
      }
      await cleanup();
    })();
    stopPromise = operation;
    // 迟到的 OS 退出事件可以让一次未确认的关闭变得可恢复。
    void operation.catch(() => { if (stopPromise === operation) stopPromise = undefined; });
    return operation;
  };

  const onAbort = () => {
    reject(aborted());
    void stop().catch(() => {});
  };

  try {
    const configPath = path.join(directory, "config.yml");
    await writeFile(configPath, "{}\n", { mode: 0o600 });
    if (options.signal?.aborted) throw aborted();

    // 这些 flag 属于全局/tunnel 层，必须在 `run` 之前。
    // 用 TCP 而不是 QUIC：UDP 受限的网络里 QUIC 会先长重试再回退。
    const args = ["--no-autoupdate", "--config", configPath, "tunnel", "--metrics", "127.0.0.1:0", "--protocol", "http2"];
    if (options.mode === "quick") args.push("--url", `http://127.0.0.1:${options.localPort}`);
    else args.push("run");

    phase(options, "starting");
    if (options.signal?.aborted) throw aborted();
    try {
      child = (dependencies.spawn ?? spawn)(binary, args, {
        cwd: directory,
        env: cloudflareProcessEnvironment(dependencies.env ?? process.env, directory, options.mode === "named" ? options.token : undefined),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new CloudflareTunnelError("runtime", "The Cloudflare connector could not be started");
    }

    let logWindow = "";
    let quickUrl: string | undefined;
    let registered = false;
    let startupErrorCode: CloudflareTunnelErrorCode | undefined;
    let refusals = 0;
    let partialLine = "";
    let routes: CloudflareTunnelRoute[] | null = null;
    const routeWaiters = new Set<() => void>();
    const releaseRouteWaiters = () => { for (const release of [...routeWaiters]) release(); };
    const onLines = (data: Buffer | string) => {
      const lines = (partialLine + String(data)).split("\n");
      partialLine = lines.pop()!;
      if (partialLine.length > MAX_LOG_LINE_BYTES) partialLine = "";
      for (const line of lines) {
        if (!registered && SERVER_REFUSAL.test(line)) refusals++;
        const pushed = readPublishedRoutes(line);
        if (pushed) { routes = pushed; releaseRouteWaiters(); }
      }
    };
    const onData = (data: Buffer | string) => {
      if (stopping) return;
      if (options.mode === "named") onLines(data);
      if (startupSettled) return;
      logWindow = (logWindow + String(data)).slice(-LOG_WINDOW_BYTES);
      quickUrl ??= logWindow.match(QUICK_URL)?.[0];
      registered ||= /\bRegistered tunnel connection\b/.test(logWindow);
      if (/provided.*token.*not valid|invalid tunnel token|failed to parse tunnel token/i.test(logWindow)) startupErrorCode = "token";
      if (/incorrect usage|flag provided but not defined|unknown flag|unknown command/i.test(logWindow)) startupErrorCode = "runtime";
      if (!registered && refusals >= TOKEN_REFUSALS) {
        reject(new CloudflareTunnelError("token", "Cloudflare refused this tunnel token"));
        return;
      }
      if (registered && (options.mode === "named" || quickUrl)) {
        startupSettled = true;
        clearTimeout(startupTimer);
        phase(options, "ready");
        resolveStartup(options.mode === "quick" ? quickUrl! : null);
      }
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null = null) => {
      if (exited) return;
      exited = true;
      exitInfo = { code, signal };
      resolveExit();
      releaseRouteWaiters();
      reject(new CloudflareTunnelError(startupErrorCode ?? "network", "Cloudflare disconnected before the connection was ready"));
      if (!stopping) {
        for (const callback of exitCallbacks) {
          try { callback(exitInfo); } catch { /* 其它观察者仍要被通知。 */ }
        }
      }
      void cleanup().catch(() => {});
    };

    child.once("exit", onExit);
    child.once("error", () => {
      reject(new CloudflareTunnelError("runtime", "The Cloudflare connector could not be started"));
      // spawn 失败没有进程可终止，也不一定会发 exit。
      if (!child?.pid) onExit(null);
      else void stop().catch(() => {});
    });
    // 就绪之后仍要继续消费两条管道，否则未读日志会把子进程堵死。
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    startupTimer = setTimeout(
      () => reject(new CloudflareTunnelError("network", "Cloudflare connection timed out")),
      dependencies.timeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    );
    phase(options, "registering");
    if (options.signal?.aborted) onAbort();

    const url = await startup;
    if (exited || options.signal?.aborted) {
      throw options.signal?.aborted ? aborted() : new CloudflareTunnelError("network", "Cloudflare disconnected before the connection was ready");
    }
    return {
      url,
      async publishedRoutes(seen, wait = {}) {
        if (routes === seen && !exited && !wait.signal?.aborted && (wait.timeoutMs === undefined || wait.timeoutMs > 0)) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await new Promise<void>((resolve) => {
            const release = () => {
              clearTimeout(timer);
              routeWaiters.delete(release);
              wait.signal?.removeEventListener("abort", release);
              resolve();
            };
            routeWaiters.add(release);
            wait.signal?.addEventListener("abort", release, { once: true });
            if (wait.timeoutMs !== undefined) timer = setTimeout(release, wait.timeoutMs);
          });
        }
        return routes;
      },
      stop,
      onExit(callback) {
        exitCallbacks.add(callback);
        if (exitInfo && !stopping) {
          queueMicrotask(() => {
            if (exitCallbacks.has(callback)) {
              try { callback(exitInfo!); } catch { /* 迟到的观察者不能打断清理。 */ }
            }
          });
        }
        return () => { exitCallbacks.delete(callback); };
      },
    };
  } catch (error) {
    await stop();
    if (error instanceof CloudflareTunnelError || (error instanceof Error && error.name === "AbortError")) throw error;
    throw new CloudflareTunnelError("runtime", "The Cloudflare connector could not be started");
  }
}
