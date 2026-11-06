/**
 * 公网访问的状态机（移植自 cc-haha 的 desktop/electron/services/publicAccess.ts，
 * 去掉 IPC、配对与设备管理，并把它的后端 HTTP 调用换成同进程直调）。
 *
 * 与 cc-haha 的差异（有意为之）：
 *   - 没有第二个监听器，隧道直指 Next 进程的端口；`localPort` 一律取运行期真实端口，
 *     用户配置里的值只是记录（避免「配 30141 却跑在 38471」这种假失败）。
 *   - 没有代理桥，错误分类里也就没有 `proxy`；重试只针对 `network`。
 *   - 配置落在 pi-web/settings.json（lib/public-access/settings.ts），不再是私有文件。
 *
 * 并发不变量（cc-haha 逐个踩出来的，别删）：
 *   - `generation` 单调递增，所有异步回调用它判断自己是否过期；
 *   - `pending`/`pendingResult` 单飞：重复 start 复用同一次尝试；
 *   - `stopUnconfirmed`：关闭没被确认前禁止新的启动，防止出现两个连接器。
 */
import { isWebPasswordEnabled } from "../web-auth.ts";
import { verifyPublicGateway } from "./gateway.ts";
import {
  isPublicAccessConfigured,
  PUBLIC_ACCESS_CONSENT_VERSION,
  readCloudflareTunnelToken,
  readPublicAccessConfig,
  writePublicAccessConfig,
  writePublicAccessOrigin,
  type PublicAccessConfig,
  type PublicAccessMode,
} from "./settings.ts";
import {
  CloudflareTunnelError,
  publishedGatewayOrigin,
  startCloudflareTunnel,
  type CloudflareTunnel,
} from "./tunnel.ts";

export type PublicAccessState = "unconfigured" | "disabled" | "connecting" | "online" | "reconnecting" | "failed";
export type PublicAccessPhase = "preparing" | "connecting" | "routing" | "checking" | null;
export type PublicAccessErrorKind = "network" | "configuration" | "token" | "route" | "runtime" | "stop";

export interface PublicAccessStatus {
  state: PublicAccessState;
  phase: PublicAccessPhase;
  error: PublicAccessErrorKind | null;
  publicUrl: string | null;
  autoStart: boolean;
  consentVersion: number;
  mode: PublicAccessMode;
  localPort: number;
  customUrl: string;
  /** 凭据是否已存；令牌本身永不外传。 */
  tokenSet: boolean;
  tunnelId: string | null;
}

/** 前端可见的配置视图：绝不含 token。 */
export interface PublicAccessView extends PublicAccessStatus {
  enabled: boolean;
}

export type PublicAccessManagerOptions = {
  settingsPath?: string;
  /** 运行期真实端口（默认读 process.env.PORT）。 */
  localPort?: () => number;
  env?: NodeJS.ProcessEnv;
  startTunnel?: typeof startCloudflareTunnel;
  verify?: (origin: string) => Promise<boolean>;
};

const CONTROLLED_ERRORS = new Set(["runtime", "network", "configuration", "token", "route"]);
/** 仪表盘托管的隧道通常在注册后立刻推路由，给它一点时间。 */
const ROUTE_WAIT_MS = 5_000;
const VERIFY_ATTEMPTS = 3;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyPublicAccessError(error: unknown): PublicAccessErrorKind {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (CONTROLLED_ERRORS.has(code)) return code as PublicAccessErrorKind;
  }
  return /configuration|invalid|consent|eaddrinuse|address already in use/i.test(messageOf(error))
    ? "configuration"
    : "network";
}

export class PublicAccessManager {
  private readonly options: PublicAccessManagerOptions;
  private settings: PublicAccessConfig;
  private status: { state: PublicAccessState; phase: PublicAccessPhase; error: PublicAccessErrorKind | null; publicUrl: string | null };
  private generation = 0;
  private wanted = false;
  private disposed = false;
  private pending: Promise<PublicAccessStatus> | null = null;
  /** start 的调用方等的是「本次尝试的结论」或「第一次等待 Cloudflare 路由」。 */
  private pendingResult: Promise<PublicAccessStatus> | null = null;
  private pendingGeneration = 0;
  private controller: AbortController | null = null;
  private tunnel: CloudflareTunnel | null = null;
  private readonly stoppingTunnels = new Set<CloudflareTunnel>();
  private readonly pendingStops = new Set<() => Promise<void>>();
  private unsubscribe: (() => void) | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private stopping = 0;
  private stopUnconfirmed = false;

  constructor(options: PublicAccessManagerOptions = {}) {
    this.options = options;
    this.settings = readPublicAccessConfig(this.settingsPath());
    this.status = {
      state: isPublicAccessConfigured(this.settings) ? "disabled" : "unconfigured",
      phase: null,
      error: null,
      publicUrl: null,
    };
  }

  private settingsPath(): string | undefined {
    return this.options.settingsPath;
  }

  private localPort(): number {
    if (this.options.localPort) return this.options.localPort();
    const parsed = Number(process.env.PORT);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 30141;
  }

  private env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private isConfigured(): boolean {
    return isPublicAccessConfigured(this.settings);
  }

  private current(generation: number): boolean {
    return generation === this.generation && !this.disposed;
  }

  private reload(): void {
    this.settings = readPublicAccessConfig(this.settingsPath());
  }

  getStatus(): PublicAccessStatus {
    this.reload();
    return {
      ...this.status,
      autoStart: this.settings.autoStart,
      consentVersion: this.settings.consentVersion,
      mode: this.settings.mode,
      localPort: this.localPort(),
      customUrl: this.settings.customUrl,
      tokenSet: this.settings.token.length > 0,
      tunnelId: readCloudflareTunnelToken(this.settings.token)?.tunnelId ?? null,
    };
  }

  /** 前端视图：配置 + 状态，永远不含 token。 */
  getView(): PublicAccessView {
    return { ...this.getStatus(), enabled: this.wanted || this.status.state === "online" };
  }

  /** 保存配置：先停掉现有隧道，再把 consentVersion 归零（改配置要重新同意）。 */
  async configure(config: PublicAccessConfig): Promise<PublicAccessView> {
    const stopped = this.stop();
    const generation = this.generation;
    await stopped;
    if (!this.current(generation)) throw new Error("Public access configuration interrupted");
    if (this.stopUnconfirmed) throw new Error("Remote gateway stop was not confirmed");
    this.settings = writePublicAccessConfig({ ...config, consentVersion: 0, origin: "" }, this.settingsPath());
    this.status = { ...this.status, phase: null, error: null, publicUrl: null, state: this.isConfigured() ? "disabled" : "unconfigured" };
    return this.getView();
  }

  setAutoStart(enabled: boolean): PublicAccessView {
    this.settings = writePublicAccessConfig({ ...this.settings, autoStart: enabled }, this.settingsPath());
    return this.getView();
  }

  /** 服务启动时的恢复：只有用户同意过、且本机设了 web 密码，才自动开洞。 */
  async restore(): Promise<PublicAccessView> {
    this.reload();
    if (this.settings.autoStart
      && this.settings.consentVersion === PUBLIC_ACCESS_CONSENT_VERSION
      && this.isConfigured()
      && isWebPasswordEnabled(this.env().PI_WEB_PASSWORD)) {
      await this.start();
    }
    return this.getView();
  }

  private assertPassword(): void {
    if (!isWebPasswordEnabled(this.env().PI_WEB_PASSWORD)) {
      throw new CloudflareTunnelError("configuration", "Set PI_WEB_PASSWORD before exposing the server on the internet");
    }
  }

  start(): Promise<PublicAccessStatus> {
    if (this.disposed) return Promise.resolve(this.getStatus());
    if (this.stopping || this.stopUnconfirmed) {
      return Promise.reject(new Error("Remote gateway stop must be confirmed before enabling access"));
    }
    this.reload();
    if (!this.isConfigured()) return Promise.reject(new Error("Configuration and current consent required"));
    this.assertPassword();
    if (this.pending) {
      if (this.pendingGeneration === this.generation) return this.pendingResult!;
      const generation = this.generation;
      return this.pending.then(() => (this.current(generation) ? this.start() : this.getStatus()));
    }
    if (this.status.state === "online") return Promise.resolve(this.getStatus());
    this.settings = writePublicAccessConfig(
      { ...this.settings, consentVersion: PUBLIC_ACCESS_CONSENT_VERSION },
      this.settingsPath(),
    );
    this.wanted = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    let routeWaitStarted!: () => void;
    const routeWait = new Promise<void>((resolve) => { routeWaitStarted = resolve; });
    const operation = this.connect(++this.generation, routeWaitStarted);
    const result = Promise.race([operation, routeWait.then(() => this.getStatus())]);
    this.pending = operation;
    this.pendingResult = result;
    this.pendingGeneration = this.generation;
    const clear = () => { if (this.pending === operation) { this.pending = null; this.pendingResult = null; } };
    void operation.then(clear, clear);
    return result;
  }

  /**
   * 仪表盘隧道的向导要等到看见本连接器才给出「路由」这一步，
   * 所以连接器要保持注册，直到推下来的路由把某个域名指向本机网关。
   */
  private async waitForRoute(
    tunnel: CloudflareTunnel,
    port: number,
    generation: number,
    signal: AbortSignal,
    onWait: () => void,
  ): Promise<string | null> {
    let routes = await tunnel.publishedRoutes(null, { timeoutMs: ROUTE_WAIT_MS, signal });
    while (this.current(generation)) {
      const origin = routes && publishedGatewayOrigin(routes, port, this.settings.customUrl || undefined);
      if (origin) { this.status.error = null; return origin; }
      this.status.phase = "routing";
      this.status.error = routes?.some((route) => route.hostname) ? "route" : null;
      onWait();
      const next = await tunnel.publishedRoutes(routes, { signal });
      if (next === routes && this.current(generation)) {
        throw new CloudflareTunnelError("network", "Cloudflare disconnected while waiting for a route");
      }
      routes = next;
    }
    return null;
  }

  private async connect(generation: number, onRouteWait: () => void): Promise<PublicAccessStatus> {
    const controller = new AbortController();
    this.controller = controller;
    this.status = {
      state: this.retryCount ? "reconnecting" : "connecting",
      error: null,
      phase: "preparing",
      publicUrl: null,
    };
    const port = this.localPort();
    try {
      const tunnel = await (this.options.startTunnel ?? startCloudflareTunnel)({
        mode: this.settings.mode,
        localPort: port,
        token: this.settings.mode === "named" ? this.settings.token : undefined,
        signal: controller.signal,
        onPhase: () => { if (this.current(generation)) this.status.phase = "connecting"; },
      });
      if (!this.current(generation)) {
        this.stoppingTunnels.add(tunnel);
        try { await tunnel.stop(); this.stoppingTunnels.delete(tunnel); }
        catch { this.stopUnconfirmed = true; this.status = { state: "failed", error: "stop", publicUrl: null, phase: null }; }
        return this.getStatus();
      }
      this.tunnel = tunnel;
      this.unsubscribe = tunnel.onExit(() => { if (this.current(generation) && this.wanted) void this.recoverAfterExit(); });
      const publicUrl = tunnel.url ?? await this.waitForRoute(tunnel, port, generation, controller.signal, onRouteWait);
      if (!publicUrl || !this.current(generation)) return this.getStatus();
      writePublicAccessOrigin(publicUrl, this.settingsPath());
      if (!this.current(generation)) return this.getStatus();
      this.status.phase = "checking";
      const verify = this.options.verify ?? verifyPublicGateway;
      let verified = false;
      for (let attempt = 0; attempt < VERIFY_ATTEMPTS && this.current(generation); attempt++) {
        if (await verify(publicUrl)) { verified = true; break; }
      }
      if (!verified) throw new CloudflareTunnelError("network", "The public hostname does not reach this gateway");
      this.status = { state: "online", error: null, phase: null, publicUrl };
      this.retryCount = 0;
    } catch (error) {
      if (error instanceof CloudflareTunnelError && error.retryStop) {
        this.pendingStops.add(error.retryStop);
        this.stopUnconfirmed = true;
        this.status = { state: "failed", error: "stop", phase: null, publicUrl: null };
      }
      if (!this.current(generation)) return this.getStatus();
      this.unsubscribe?.();
      this.unsubscribe = null;
      const tunnel = this.tunnel;
      this.tunnel = null;
      controller.abort();
      let closed = this.pendingStops.size === 0;
      if (tunnel) this.stoppingTunnels.add(tunnel);
      for (const closing of this.stoppingTunnels) {
        try { await closing.stop(); this.stoppingTunnels.delete(closing); } catch { closed = false; }
      }
      try { writePublicAccessOrigin(null, this.settingsPath()); } catch { closed = false; }
      if (!this.current(generation)) return this.getStatus();
      if (!closed) {
        this.stopUnconfirmed = true;
        this.status = { state: "failed", error: "stop", phase: null, publicUrl: null };
      } else {
        const category = classifyPublicAccessError(error);
        this.status = { state: "failed", error: category, phase: null, publicUrl: null };
        if (category === "network") this.scheduleRetry();
      }
    }
    return this.getStatus();
  }

  private scheduleRetry(): void {
    if (!this.wanted || this.disposed || this.stopUnconfirmed) return;
    this.status.state = "reconnecting";
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.start().catch(() => {});
    }, Math.min(30_000, 1000 * 2 ** this.retryCount++));
    this.retry.unref?.();
  }

  private async recoverAfterExit(): Promise<void> {
    const resume = this.wanted;
    const stopped = this.stop();
    const generation = this.generation;
    this.wanted = resume;
    await stopped;
    if (this.current(generation) && resume && !this.stopUnconfirmed) this.scheduleRetry();
  }

  async stop(): Promise<PublicAccessStatus> {
    this.wanted = false;
    const generation = ++this.generation;
    this.controller?.abort();
    this.controller = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const tunnel = this.tunnel;
    this.tunnel = null;
    if (tunnel) this.stoppingTunnels.add(tunnel);
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.retryCount = 0;
    // 被中止的启动要单飞到底：关闭失败必须被观察到，之后才允许再起连接器。
    this.stopping++;
    let closed = true;
    try {
      for (const closing of this.stoppingTunnels) {
        try { await closing.stop(); this.stoppingTunnels.delete(closing); } catch { closed = false; }
      }
      for (const retryStop of this.pendingStops) {
        try { await retryStop(); this.pendingStops.delete(retryStop); } catch { closed = false; }
      }
      try { writePublicAccessOrigin(null, this.settingsPath()); } catch { closed = false; }
      if (generation === this.generation) {
        this.stopUnconfirmed = !closed;
        this.status = {
          publicUrl: null,
          phase: null,
          error: closed ? null : "stop",
          state: closed ? (this.isConfigured() ? "disabled" : "unconfigured") : "failed",
        };
      }
    } finally {
      this.stopping--;
    }
    return this.getStatus();
  }

  /** 服务器不可用（例如桌面壳重启）：停掉并等它回来。 */
  async serverUnavailable(): Promise<void> {
    const resume = this.wanted;
    const stopped = this.stop();
    const generation = this.generation;
    this.wanted = resume;
    await stopped;
    if (generation === this.generation && resume && !this.stopUnconfirmed) this.status.state = "reconnecting";
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const pending = this.pending;
    await this.stop();
    // 启动过程在返回句柄前一直拥有连接器的清理权，等它把有界关闭做完。
    await pending?.catch(() => {});
  }
}
