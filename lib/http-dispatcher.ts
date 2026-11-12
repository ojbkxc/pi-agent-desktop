import { EventEmitter } from "node:events";
import * as undici from "undici";

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

  const dispatcher = withUndiciErrorListener(
    new undici.EnvHttpProxyAgent({
      allowH2: false,
      bodyTimeout: normalizedTimeoutMs,
      headersTimeout: normalizedTimeoutMs,
      clientFactory: createUndiciClient,
      factory: createUndiciOriginDispatcher,
    }),
  );
  const previous = dispatcherGlobal.__piWebHttpDispatcher;
  undici.setGlobalDispatcher(dispatcher);

  dispatcherGlobal.__piWebHttpDispatcher = dispatcher;
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
