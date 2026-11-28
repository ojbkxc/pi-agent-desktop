import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as undici from "undici";
import { readRegularFileText } from "./regular-file";

/**
 * How long a response body may stay silent before undici aborts it.
 *
 * This is an *idle* timer: undici refreshes it on every chunk, so a stream that
 * keeps sending keeps living regardless of total duration. It is set well above
 * a model's thinking time on purpose — a relay that buffers a stream, or a
 * reasoning model that emits nothing for minutes, would otherwise be cut off
 * mid-response and seen upstream as "client disconnected before the response
 * completed". Override with PI_WEB_HTTP_IDLE_TIMEOUT_MS (ms, or "disabled").
 */
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 10 * 60_000;

type DispatcherGlobal = typeof globalThis & {
  __piWebHttpDispatcherConfigured?: boolean;
  __piWebHttpDispatcher?: undici.Dispatcher;
  /** 代理生效期间被换掉的 fetch（通常是 Next 补丁版），恢复时用。 */
  __piWebProxyFetchInstalled?: boolean;
  __piWebProxyFetchOriginal?: typeof globalThis.fetch;
  __piWebHttpDispatcherTimeoutMs?: number;
};

const dispatcherGlobal = globalThis as DispatcherGlobal;
const ignoreUndiciDispatcherError = (): void => {};

function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "disabled") return 0;
    if (trimmed.length === 0) return undefined;
    return parseHttpIdleTimeoutMs(Number(trimmed));
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

/**
 * The agent directory pi keeps its global `settings.json` in, resolved as pi's
 * `getAgentDir()` resolves it. It is resolved here instead of through the SDK
 * because this module runs in Next.js instrumentation: importing the SDK there
 * costs about a second of startup time, while `undici` costs a tenth of one.
 */
export function defaultAgentDir(): string {
  let configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".pi", "agent");

  // pi's normalizePath(): Git Bash, MSYS, Cygwin and WSL drive paths on
  // Windows, then `~`, then file: URLs. The value is not trimmed.
  if (process.platform === "win32") configured = windowsShellPath(configured);
  if (configured === "~") return homedir();
  if (configured.startsWith("~/") || (process.platform === "win32" && configured.startsWith("~\\"))) {
    return join(homedir(), configured.slice(2));
  }
  if (/^file:\/\//.test(configured)) return fileURLToPath(configured);
  return configured;
}

/** pi's normalizeWindowsShellPath(): `/c/x`, `/mnt/c/x`, `/cygdrive/c/x` to `C:\x`. */
function windowsShellPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
  const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return path;
  return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

/**
 * The global `httpIdleTimeoutMs`, read the way the pi CLI reads it, so a Web UI
 * session gets the HTTP idle timeout the user configured instead of the
 * built-in default. Only the global file counts: the dispatcher is configured
 * once at startup, before any project is selected, so a project's
 * `.pi/settings.json` cannot apply here.
 *
 * A missing file, a file that does not parse, an absent key, or a value the CLI
 * would reject yields `undefined`, which leaves `configureHttpDispatcher`'s own
 * default in place.
 */
export function readHttpIdleTimeoutMs(agentDir: string = defaultAgentDir()): number | undefined {
  let text: string | undefined;
  try {
    text = readRegularFileText(join(agentDir, "settings.json"));
  } catch {
    return undefined;
  }
  if (text === undefined) return undefined;

  let settings: unknown;
  try {
    settings = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return undefined;
  }
  if (typeof settings !== "object" || settings === null) return undefined;

  return parseHttpIdleTimeoutMs((settings as { httpIdleTimeoutMs?: unknown }).httpIdleTimeoutMs);
}

// Undici can emit an internal Client error while terminating a response body.
// The body stream still rejects; this prevents the EventEmitter error from
// terminating the Next.js process first.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
  return withUndiciErrorListener(
    new undici.Client(origin, options as undici.Client.Options),
  );
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
  const dispatcherOptions = options as undici.Pool.Options;
  if (dispatcherOptions.connections === 1) {
    return createUndiciClient(origin, dispatcherOptions);
  }

  return withUndiciErrorListener(
    new undici.Pool(origin, {
      ...dispatcherOptions,
      factory: createUndiciClient,
    }),
  );
}

/**
 * The idle timeout to configure: `PI_WEB_HTTP_IDLE_TIMEOUT_MS` as a number of
 * milliseconds, or `disabled`/`0` to leave body stalls entirely to the caller's
 * own AbortSignal. An unset, blank or unusable value falls back to the default.
 */
export function resolveHttpIdleTimeoutMs(
  rawValue: string | undefined = process.env.PI_WEB_HTTP_IDLE_TIMEOUT_MS,
): number {
  if (rawValue === undefined || rawValue.trim() === "") return DEFAULT_HTTP_IDLE_TIMEOUT_MS;
  const parsed = parseHttpIdleTimeoutMs(rawValue);
  if (parsed === undefined) {
    console.warn(
      `[pi-web] invalid PI_WEB_HTTP_IDLE_TIMEOUT_MS "${rawValue}", falling back to ${DEFAULT_HTTP_IDLE_TIMEOUT_MS} ms`,
    );
    return DEFAULT_HTTP_IDLE_TIMEOUT_MS;
  }
  return parsed;
}

function createProxyAwareDispatcher(timeoutMs: number): undici.Dispatcher {
  // EnvHttpProxyAgent reads HTTP(S)_PROXY when it is built (NO_PROXY on every
  // request), so a proxy change in Settings rebuilds it; see lib/network-proxy.ts.
  return withUndiciErrorListener(
    new undici.EnvHttpProxyAgent({
      allowH2: false,
      // Reach an http:// origin through a CONNECT tunnel, as the pi SDK's own
      // dispatcher does. A forwarded request is carried by a client that keeps
      // undici's own 300 s bodyTimeout, so `httpIdleTimeoutMs` would not apply
      // and a provider stream that stalls cannot be cut at the configured time.
      proxyTunnel: true,
      bodyTimeout: timeoutMs,
      // Node's 250 ms default can terminate valid connection attempts on
      // high-latency routes; the pi CLI's dispatcher waits two seconds here.
      connect: { autoSelectFamilyAttemptTimeout: 2_000 },
      headersTimeout: timeoutMs,
      clientFactory: createUndiciClient,
      factory: createUndiciOriginDispatcher,
    }),
  );
}

export function configureHttpDispatcher(
  timeoutMs: number | string = resolveHttpIdleTimeoutMs(),
): void {
  installHttpDispatcher({ timeoutMs });
}

export interface InstallHttpDispatcherOptions {
  /** Idle timeout in ms, or a `PI_WEB_HTTP_IDLE_TIMEOUT_MS`-style string. */
  timeoutMs?: number | string;
  /**
   * Install even when a dispatcher is already configured. Needed after the
   * proxy settings change: `EnvHttpProxyAgent` reads `HTTP_PROXY` /
   * `HTTPS_PROXY` **once, in its constructor**, so a new URL only takes effect
   * with a new instance. (`NO_PROXY` alone is re-read on every dispatch.)
   */
  force?: boolean;
}

/**
 * Install the process-wide undici dispatcher: env-driven proxy support plus the
 * idle timeout. Idempotent unless `force` is set.
 *
 * Replacing a dispatcher while a model stream is running is safe here: the old
 * one is `close()`d — graceful, so in-flight response bodies finish and only
 * new sockets are refused. It is deliberately not `destroy()`ed, which would
 * cut a live stream in half the moment the user flips the proxy setting.
 */
export function installHttpDispatcher(options: InstallHttpDispatcherOptions = {}): void {
  const { force = false } = options;
  if (dispatcherGlobal.__piWebHttpDispatcherConfigured && !force) return;

  const normalizedTimeoutMs = parseHttpIdleTimeoutMs(options.timeoutMs ?? resolveHttpIdleTimeoutMs());
  if (normalizedTimeoutMs === undefined) {
    throw new Error(`Invalid HTTP idle timeout: ${String(options.timeoutMs)}`);
  }

  const dispatcher = createProxyAwareDispatcher(normalizedTimeoutMs);
  const previous = dispatcherGlobal.__piWebHttpDispatcher;
  undici.setGlobalDispatcher(dispatcher);
  dispatcherGlobal.__piWebHttpDispatcher = dispatcher;
  dispatcherGlobal.__piWebHttpDispatcherTimeoutMs = normalizedTimeoutMs;

  dispatcherGlobal.__piWebHttpDispatcherConfigured = true;
  if (previous && previous !== dispatcher) {
    void Promise.resolve(previous.close()).catch(ignoreUndiciDispatcherError);
  }
}

/**
 * 让**进程内的全局 `fetch`** 也走这个 dispatcher。
 *
 * 为什么需要单独一步：`setGlobalDispatcher` 只影响 **undici 这个 npm 包自己的** fetch。
 * 而 Next 会在服务端启动早期把 `globalThis.fetch` 换成它自己的补丁版（`patch-fetch.js`
 * 的 `patchFetch()`，以 `globalThis[NEXT_PATCH_SYMBOL]` 为哨兵，只会补一次），那个补丁
 * 包装的是**Node 内建的** fetch —— 它读 Node 内建 undici 的 dispatcher，跟我们这个 npm
 * 包毫无关系。于是「装了 dispatcher」在真实服务端里对 route handler / pi-ai 的请求**完全
 * 不起作用**（实测：把代理指到一个死端口，技能市场的实时源照样成功）。
 *
 * 所以代理生效时必须把 `globalThis.fetch` 换成 undici 包自己的 fetch（它读我们的 dispatcher）。
 * 换上去之后 Next 不会再补一次（哨兵已置位），代价是那层补丁（dedupe / 请求内 trace /
 * `next: { revalidate }` 缓存）在「代理开启」期间不生效 —— 本仓的 route 全是
 * `force-dynamic` 且不用 `next:` 选项，所以这个代价可以接受；也正因如此，**只在真的配了
 * 代理时才换**，`direct`（以及没探测到系统代理）时原样保留 Next 的补丁。
 *
 * 只换 `fetch` 一个全局：`undici.install()` 会把 `Headers` / `Response` / `Request` /
 * `WebSocket` 一起换掉，那会让 Next 与中继里 `instanceof` 之类的判断出现两套类，风险更大。
 */
export function applyGlobalFetchForProxy(active: boolean): void {
  if (active) {
    if (dispatcherGlobal.__piWebProxyFetchInstalled) return;
    dispatcherGlobal.__piWebProxyFetchOriginal = globalThis.fetch;
    globalThis.fetch = undici.fetch as unknown as typeof globalThis.fetch;
    dispatcherGlobal.__piWebProxyFetchInstalled = true;
    return;
  }
  if (!dispatcherGlobal.__piWebProxyFetchInstalled) return;
  if (dispatcherGlobal.__piWebProxyFetchOriginal) {
    globalThis.fetch = dispatcherGlobal.__piWebProxyFetchOriginal;
  }
  dispatcherGlobal.__piWebProxyFetchOriginal = undefined;
  dispatcherGlobal.__piWebProxyFetchInstalled = false;
}

/**
 * Rebuild the global dispatcher from the current proxy environment. Requests
 * already in flight (streaming replies included) finish on the old dispatcher,
 * which closes once they are done. A no-op before configureHttpDispatcher().
 */
export function reconfigureHttpDispatcher(): void {
  if (!dispatcherGlobal.__piWebHttpDispatcherConfigured) return;
  const timeoutMs = dispatcherGlobal.__piWebHttpDispatcherTimeoutMs ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
  const previous = dispatcherGlobal.__piWebHttpDispatcher;
  const dispatcher = createProxyAwareDispatcher(timeoutMs);
  undici.setGlobalDispatcher(dispatcher);
  dispatcherGlobal.__piWebHttpDispatcher = dispatcher;
  if (previous && previous !== dispatcher) {
    void previous.close().catch(ignoreUndiciDispatcherError);
  }
}
