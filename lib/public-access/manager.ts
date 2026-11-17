/**
 * 公网访问的状态机（移植自 cc-haha 的 desktop/electron/services/publicAccess.ts，
 * 去掉 IPC、配对与设备管理，并把它的后端 HTTP 调用换成同进程直调）。
 *
 * 与 cc-haha 的差异（有意为之）：
 *   - 没有第二个监听器，隧道直指 Next 进程的端口；`localPort` 一律取运行期真实端口，
 *     用户配置里的值只是记录（避免「配 30141 却跑在 38471」这种假失败）。
 *   - 配置落在 pi-web/settings.json（lib/public-access/settings.ts），不再是私有文件。
 *
 * 代理桥（见 lib/public-access/cloudflare-proxy.ts）：本类在 start 时读一次网络代理设置，
 * 有代理就先起桥并把句柄交给 tunnel.ts（`--edge` / `--quick-service`），自己持有桥的生命周期
 * —— stop / dispose / 失败重试都要确保桥被关闭，否则本地端口会泄漏。桥起不来归 `proxy`
 * 错误，**不**走 network 重试（重试没用，要用户改代理设置）。
 *
 * 并发不变量（cc-haha 逐个踩出来的，别删）：
 *   - `generation` 单调递增，所有异步回调用它判断自己是否过期；
 *   - `pending`/`pendingResult` 单飞：重复 start 复用同一次尝试；
 *   - `stopUnconfirmed`：关闭没被确认前禁止新的启动，防止出现两个连接器。
 */
import { randomUUID } from "node:crypto";
import { isWebPasswordSourceActive } from "../web-auth.ts";
import { readNetworkProxySettings, resolveOutboundProxyUrl } from "../network-proxy.ts";
import { classifyDomainBinding, type DomainBindingStatus } from "./binding.ts";
import { gatewayId, verifyPublicGateway } from "./gateway.ts";
import {
  recordDiagnostic,
  recentDiagnostics,
  type PublicAccessDiagnostic,
  type PublicAccessDiagnosticWriter,
} from "./diagnostics.ts";
import { startCloudflareProxyTransport, type CloudflareProxyTransport } from "./cloudflare-proxy.ts";
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
export type PublicAccessErrorKind = "network" | "configuration" | "token" | "route" | "runtime" | "stop" | "proxy";

export interface PublicAccessStatus {
  state: PublicAccessState;
  phase: PublicAccessPhase;
  error: PublicAccessErrorKind | null;
  publicUrl: string | null;
  /**
   * 命名隧道 + 自定义域名的固定域名绑定判定（轮询推送规则的结论）；
   * quick 模式与未填自定义域名的命名隧道恒为 null——地址由 Cloudflare 分配，
   * 没有「绑定」概念。
   */
  domainBinding: DomainBindingStatus | null;
  /** 本次 online 是否由 restore()（服务器启动时的自动恢复）建立。 */
  restoredByAutoStart: boolean;
  autoStart: boolean;
  consentVersion: number;
  mode: PublicAccessMode;
  localPort: number;
  customUrl: string;
  /** 凭据是否已存；令牌本身永不外传。 */
  tokenSet: boolean;
  tunnelId: string | null;
  /** 最近 20 条诊断事件（脱敏后），设置页据此显示「上次失败卡在哪一步」。 */
  diagnostics: PublicAccessDiagnostic[];
}

/** 前端可见的配置视图：绝不含 token。 */
export interface PublicAccessView extends PublicAccessStatus {
  enabled: boolean;
}

/** waitForRoute 的结论：拿到入口 origin / 固定域名绑定超时（null = 已被取代）。 */
type RouteDiscovery = { status: "origin"; origin: string } | { status: "timeout" };

export type PublicAccessManagerOptions = {
  settingsPath?: string;
  /** 运行期真实端口（默认读 process.env.PORT）。 */
  localPort?: () => number;
  env?: NodeJS.ProcessEnv;
  startTunnel?: typeof startCloudflareTunnel;
  verify?: (origin: string) => Promise<boolean>;
  /** 代理桥构建器（单测注入）；默认 startCloudflareProxyTransport。 */
  startProxyTransport?: typeof startCloudflareProxyTransport;
  /** 桥用的代理 URL 解析（单测注入）；默认读 pi-web 设置文件的 networkProxy 键。 */
  resolveProxyUrl?: () => string | null;
  /** 诊断写入器（单测捕获）；默认写进程内环形缓冲（recordDiagnostic）。 */
  diagnosticWriter?: PublicAccessDiagnosticWriter;
  /** 公网校验的等待节奏（默认 VERIFY_WAITS_MS，测试注入短值）。 */
  verifyWaitsMs?: number[];
  /** 公网校验的总预算（默认 VERIFY_BUDGET_MS）。 */
  verifyBudgetMs?: number;
  /** 固定域名绑定的轮询预算（默认 DOMAIN_BINDING_BUDGET_MS）。 */
  bindingBudgetMs?: number;
};

const CONTROLLED_ERRORS = new Set(["runtime", "network", "configuration", "token", "route", "proxy"]);
/** 仪表盘托管的隧道通常在注册后立刻推路由，给它一点时间。 */
const ROUTE_WAIT_MS = 5_000;
/**
 * 公网校验的分间隔节奏（参照 cc-haha）：首查立即，之后逐次放长。
 * 新域名的 DNS 传播常让首查失败——立即三连败会误判成网络故障，
 * 把隧道拆了重建，反而永远连不上。
 */
const VERIFY_WAITS_MS = [0, 2_000, 4_000, 8_000, 15_000];
/** 最后一次校验的开始时刻不晚于首次之后这个预算。 */
const VERIFY_BUDGET_MS = 45_000;
/** 固定域名绑定的轮询预算：预算内没等到「指向本机网关的推送规则」就报超时。 */
const DOMAIN_BINDING_BUDGET_MS = 60_000;

/**
 * 等待 milliseconds 毫秒；signal 中止则提前返回 false。计时器总会被清掉。
 * （移植自 cc-haha 的 publicAccess.ts pause()。）
 */
function pause(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return; }
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      resolve(completed);
    };
    const aborted = () => finish(false);
    const timer = setTimeout(() => finish(true), milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

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
  private status: {
    state: PublicAccessState;
    phase: PublicAccessPhase;
    error: PublicAccessErrorKind | null;
    publicUrl: string | null;
    domainBinding: DomainBindingStatus | null;
    restoredByAutoStart: boolean;
  };
  private generation = 0;
  private wanted = false;
  private disposed = false;
  private pending: Promise<PublicAccessStatus> | null = null;
  /** start 的调用方等的是「本次尝试的结论」或「第一次等待 Cloudflare 路由」。 */
  private pendingResult: Promise<PublicAccessStatus> | null = null;
  private pendingGeneration = 0;
  private controller: AbortController | null = null;
  private tunnel: CloudflareTunnel | null = null;
  /** 当前尝试的代理桥（null = 直连）。stop/dispose/失败重试都要关掉它，防端口泄漏。 */
  private bridge: CloudflareProxyTransport | null = null;
  /** 本轮尝试的代理 URL（探针复用同一条出网路径）；null = 直连。 */
  private attemptProxyUrl: string | null = null;
  private readonly stoppingTunnels = new Set<CloudflareTunnel>();
  private readonly pendingStops = new Set<() => Promise<void>>();
  private unsubscribe: (() => void) | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private stopping = 0;
  private stopUnconfirmed = false;
  /** restore() 发起的启动：connect 消费（一次性），成功 online 后写进状态。 */
  private autoStartRestore = false;

  constructor(options: PublicAccessManagerOptions = {}) {
    this.options = options;
    this.settings = readPublicAccessConfig(this.settingsPath());
    // 自愈（H5-4）：origin 正常只在 gateway 验证通过后写入、stop/失败时清除
    // （start 的 catch 与 stop() 都写 null）。若进程恰在「写入后、清除前」
    // 被 SIGKILL，文件里会留下一个上一进程的 origin——它对应的主机名在下次
    // 启动后仍会被 proxy 当作可信隧道来源。构造即清（此时状态恒非 online，
    // 任何非空 origin 都必然是残留）；只做收紧，不违反「手改设置文件不得
    // 放宽白名单」——真正的 origin 由本次 start() 验证通过后重新写入。
    if (this.settings.origin) {
      try {
        writePublicAccessOrigin(null, this.settingsPath());
      } catch {
        // 只读设置文件：残留保留，proxy 侧的密码前置仍是硬门槛。
      }
      this.settings = readPublicAccessConfig(this.settingsPath());
    }
    this.status = {
      state: isPublicAccessConfigured(this.settings) ? "disabled" : "unconfigured",
      phase: null,
      error: null,
      publicUrl: null,
      domainBinding: null,
      restoredByAutoStart: false,
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

  /**
   * 读一次网络代理设置，得到「桥该用的代理 URL」（保留 userinfo 以便握手认证）。
   *   - manual：直接用设置里的 URL（readNetworkProxySettings 已归一化、且不剥凭据）；
   *   - direct：null；
   *   - system：applyNetworkProxy 已把生效 URL 写进进程环境变量，从那里取（可能已剥凭据，
   *     系统代理一般也无凭据）——探测是异步的，这里不重复探测。
   * 非 http/https 的代理 URL 归一化后为空串，等价「没配」。
   */
  private resolveProxyUrl(): string | null {
    if (this.options.resolveProxyUrl) return this.options.resolveProxyUrl();
    // 与诊断路由共用同一个 helper：两处各写一份必然漂移，而漂移的表现就是
    // 「隧道通了、诊断说没通」。
    return resolveOutboundProxyUrl(readNetworkProxySettings(this.settingsPath()), this.env());
  }

  /**
   * 写一条诊断事件。注入的 writer 只补 attemptId（测试自己决定怎么断言）；默认写
   * recordDiagnostic，并用 secrets（token + 代理 URL）脱敏后再入环形缓冲。
   */
  private writeDiagnostic(attemptId: string, secrets: readonly string[], event: PublicAccessDiagnostic): void {
    const writer = this.options.diagnosticWriter;
    if (writer) {
      try { writer({ ...event, attemptId }); } catch { /* 诊断是旁路。 */ }
      return;
    }
    recordDiagnostic({ ...event, attemptId }, secrets);
  }

  /** 关掉当前代理桥并把它从字段里摘掉；关闭失败返回 false（由调用方决定是否升级为 stop 错误）。 */
  private async stopBridge(): Promise<boolean> {
    const bridge = this.bridge;
    this.bridge = null;
    if (!bridge) return true;
    try {
      await bridge.stop();
      return true;
    } catch {
      return false;
    }
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
      diagnostics: recentDiagnostics(),
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
    this.status = {
      ...this.status,
      phase: null,
      error: null,
      publicUrl: null,
      domainBinding: null,
      restoredByAutoStart: false,
      state: this.isConfigured() ? "disabled" : "unconfigured",
    };
    return this.getView();
  }

  setAutoStart(enabled: boolean): PublicAccessView {
    this.settings = writePublicAccessConfig({ ...this.settings, autoStart: enabled }, this.settingsPath());
    return this.getView();
  }

  /** 服务启动时的恢复：只有用户同意过、且本机设了 web 密码（env 或设置文件记录），才自动开洞。 */
  async restore(): Promise<PublicAccessView> {
    this.reload();
    if (this.settings.autoStart
      && this.settings.consentVersion === PUBLIC_ACCESS_CONSENT_VERSION
      && this.isConfigured()
      && isWebPasswordSourceActive(this.env().PI_WEB_PASSWORD)) {
      // 一次性标记：connect 开头同步消费，成功 online 后状态里标注「按自动启动恢复」。
      // finally 兜底清掉 start 在 connect 之前就被拒绝（stopUnconfirmed 等）时的残留。
      this.autoStartRestore = true;
      try { await this.start(); } finally { this.autoStartRestore = false; }
    }
    return this.getView();
  }

  private assertPassword(): void {
    if (!isWebPasswordSourceActive(this.env().PI_WEB_PASSWORD)) {
      throw new CloudflareTunnelError("configuration", "Set a web password in Settings before exposing the server on the internet");
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
   * waitForRoute 的结论：拿到入口 origin / 固定域名绑定超时 / null（已被取代）。
   *
   * 仪表盘隧道的向导要等到看见本连接器才给出「路由」这一步，
   * 所以连接器要保持注册，直到推下来的路由把某个域名指向本机网关。
   *
   * 两条路径：
   *   - 未填自定义域名（quick 永不走这里）：沿用原逻辑，取第一条指向本机
   *     网关的路由，推送不到就等连接器退出。
   *   - 填了自定义域名（named + customUrl）：在预算内轮询推送的 ingress 规则。
   *     匹配自定义域名且指向本机网关 → 绑定成功；只推来别的域名 → 立即在
   *     状态里给出「未绑定」结论（设置页据此显示指引）并继续等用户在
   *     Cloudflare 控制台补路由（推送到达即自动绑定，无需重启隧道）；
   *     预算耗尽仍未绑定 → timeout 结论，由 connect 落成 failed(route)。
   */
  private async waitForRoute(
    tunnel: CloudflareTunnel,
    port: number,
    generation: number,
    signal: AbortSignal,
    onWait: () => void,
  ): Promise<RouteDiscovery | null> {
    let routes = await tunnel.publishedRoutes(null, { timeoutMs: ROUTE_WAIT_MS, signal });
    const customUrl = this.settings.mode === "named" ? this.settings.customUrl : "";
    if (!customUrl) {
      while (this.current(generation)) {
        const origin = routes && publishedGatewayOrigin(routes, port);
        if (origin) { this.status.error = null; return { status: "origin", origin }; }
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
    const deadline = Date.now() + (this.options.bindingBudgetMs ?? DOMAIN_BINDING_BUDGET_MS);
    while (this.current(generation)) {
      const binding = classifyDomainBinding(routes, customUrl, port);
      this.status.domainBinding = { state: binding.state, reason: binding.reason };
      if (binding.state === "bound") {
        this.status.error = null;
        return { status: "origin", origin: binding.origin! };
      }
      this.status.phase = "routing";
      this.status.error = routes?.some((route) => route.hostname) ? "route" : null;
      onWait();
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: "timeout" };
      const next = await tunnel.publishedRoutes(routes, { timeoutMs: remaining, signal });
      if (!this.current(generation)) return null;
      if (next === routes) {
        // 等待只有「新推送 / 中止 / 超时 / 连接器退出」四种出口；中止与退出已被
        // current() 截住。超时刚好压线时在这里收口，其余（理论上不可达）下轮重判。
        if (Date.now() >= deadline) return { status: "timeout" };
        continue;
      }
      routes = next;
    }
    return null;
  }

  private async connect(generation: number, onRouteWait: () => void): Promise<PublicAccessStatus> {
    // 一次性消费 restore() 的标记：成功 online 后状态里标注「按自动启动恢复」。
    // connect 被 start() 同步调用，消费一定发生在 restore() 的 finally 清理之前。
    const restoredByAutoStart = this.autoStartRestore;
    this.autoStartRestore = false;
    const controller = new AbortController();
    this.controller = controller;
    this.status = {
      state: this.retryCount ? "reconnecting" : "connecting",
      error: null,
      phase: "preparing",
      publicUrl: null,
      domainBinding: null,
      restoredByAutoStart: false,
    };
    const port = this.localPort();
    // 固定域名绑定超时的标记：终态里保留 timeout 结论（其余失败一律清空绑定状态）。
    let bindingTimeout = false;

    // 本次尝试的因果 id（诊断事件共享它）与需要脱敏的凭据（token + 代理 URL）。
    const attemptId = randomUUID();
    const proxyUrl = this.resolveProxyUrl();
    this.attemptProxyUrl = proxyUrl;
    const secrets = [this.settings.token, proxyUrl ?? ""];
    const write = (event: PublicAccessDiagnostic): void => this.writeDiagnostic(attemptId, secrets, event);
    const attemptStartedAt = Date.now();
    write({ stage: "preparing", outcome: "started" });

    try {
      // 有代理就先起桥：连接器不知道代理，只认桥的本地入口（--edge / --quick-service）。
      if (proxyUrl) {
        const proxyStartedAt = Date.now();
        write({ stage: "proxy_transport", outcome: "started" });
        try {
          const bridge = await (this.options.startProxyTransport ?? startCloudflareProxyTransport)(proxyUrl, {
            signal: controller.signal,
            onDiagnostic: write,
          });
          this.bridge = bridge;
          write({ stage: "proxy_transport", outcome: "succeeded", durationMs: Date.now() - proxyStartedAt });
        } catch (error) {
          write({
            stage: "proxy_transport",
            outcome: controller.signal.aborted ? "cancelled" : "failed",
            reason: "transport_setup_failed",
            error,
            durationMs: Date.now() - proxyStartedAt,
          });
          throw controller.signal.aborted
            ? new Error("Public access start cancelled")
            : new CloudflareTunnelError("proxy", "The Cloudflare connector could not use the configured network proxy");
        }
      }
      write({ stage: "preparing", outcome: "succeeded", durationMs: Date.now() - attemptStartedAt });

      const tunnel = await (this.options.startTunnel ?? startCloudflareTunnel)({
        mode: this.settings.mode,
        localPort: port,
        token: this.settings.mode === "named" ? this.settings.token : undefined,
        signal: controller.signal,
        onPhase: () => { if (this.current(generation)) this.status.phase = "connecting"; },
        proxyBridge: this.bridge ?? undefined,
        onDiagnostic: write,
      });
      if (!this.current(generation)) {
        this.stoppingTunnels.add(tunnel);
        let closed = await this.stopBridge();
        try { await tunnel.stop(); this.stoppingTunnels.delete(tunnel); }
        catch { closed = false; }
        if (!closed) {
          this.stopUnconfirmed = true;
          this.status = { state: "failed", error: "stop", publicUrl: null, phase: null, domainBinding: null, restoredByAutoStart: false };
        }
        return this.getStatus();
      }
      this.tunnel = tunnel;
      this.unsubscribe = tunnel.onExit(() => { if (this.current(generation) && this.wanted) void this.recoverAfterExit(); });
      // quick 模式的入口来自日志 URL（tunnel.url）；命名隧道走推送规则。
      let discovery: RouteDiscovery | null;
      if (tunnel.url) {
        discovery = { status: "origin", origin: tunnel.url };
      } else {
        const routesStartedAt = Date.now();
        write({ stage: "routes", outcome: "started" });
        try {
          discovery = await this.waitForRoute(tunnel, port, generation, controller.signal, onRouteWait);
          write({
            stage: "routes",
            outcome: discovery?.status === "timeout" ? "failed" : "succeeded",
            ...(discovery?.status === "timeout" ? { reason: "binding_timeout" } : {}),
            durationMs: Date.now() - routesStartedAt,
          });
        } catch (error) {
          write({ stage: "routes", outcome: "failed", reason: "route_wait_failed", error, durationMs: Date.now() - routesStartedAt });
          throw error;
        }
      }
      if (!discovery || !this.current(generation)) return this.getStatus();
      if (discovery.status === "timeout") {
        bindingTimeout = true;
        this.status.domainBinding = { state: "timeout", reason: null };
        throw new CloudflareTunnelError("route", "The custom domain was not bound before the route wait expired");
      }
      const publicUrl = discovery.origin;
      writePublicAccessOrigin(publicUrl, this.settingsPath());
      if (!this.current(generation)) return this.getStatus();
      this.status.phase = "checking";
      const verifyStartedAt = Date.now();
      write({ stage: "verifying", outcome: "started" });
      const verified = await this.verifyWithRetries(publicUrl, generation, controller.signal);
      if (!verified) {
        write({ stage: "verifying", outcome: "failed", reason: "gateway_unreachable", durationMs: Date.now() - verifyStartedAt });
        throw new CloudflareTunnelError("network", "The public hostname does not reach this gateway");
      }
      write({ stage: "verifying", outcome: "succeeded", durationMs: Date.now() - verifyStartedAt });
      this.status = {
        state: "online",
        error: null,
        phase: null,
        publicUrl,
        domainBinding: this.status.domainBinding,
        restoredByAutoStart,
      };
      write({ stage: "online", outcome: "succeeded", durationMs: Date.now() - attemptStartedAt, ...(publicUrl ? { details: { url: publicUrl } } : {}) });
      this.retryCount = 0;
    } catch (error) {
      if (error instanceof CloudflareTunnelError && error.retryStop) {
        this.pendingStops.add(error.retryStop);
        this.stopUnconfirmed = true;
        this.status = { state: "failed", error: "stop", phase: null, publicUrl: null, domainBinding: null, restoredByAutoStart: false };
      }
      if (!this.current(generation)) return this.getStatus();
      this.unsubscribe?.();
      this.unsubscribe = null;
      const tunnel = this.tunnel;
      this.tunnel = null;
      controller.abort();
      let closed = this.pendingStops.size === 0;
      // 桥的关闭不因 pendingStops 而短路：它和连接器的关闭是两件事，都要做。
      if (!await this.stopBridge()) closed = false;
      if (tunnel) this.stoppingTunnels.add(tunnel);
      for (const closing of this.stoppingTunnels) {
        try { await closing.stop(); this.stoppingTunnels.delete(closing); } catch { closed = false; }
      }
      try { writePublicAccessOrigin(null, this.settingsPath()); } catch { closed = false; }
      if (!this.current(generation)) return this.getStatus();
      if (!closed) {
        this.stopUnconfirmed = true;
        this.status = { state: "failed", error: "stop", phase: null, publicUrl: null, domainBinding: null, restoredByAutoStart: false };
      } else {
        const category = classifyPublicAccessError(error);
        this.status = {
          state: "failed",
          error: category,
          phase: null,
          publicUrl: null,
          domainBinding: bindingTimeout ? { state: "timeout", reason: null } : null,
          restoredByAutoStart: false,
        };
        if (category === "network") this.scheduleRetry();
      }
    }
    return this.getStatus();
  }

  /**
   * 公网校验按分间隔节奏重试（参照 cc-haha 的 VERIFY_WAITS_MS）：新域名/新地址的
   * DNS 传播常让首查失败，立即三连败会误判成网络故障并把隧道拆了重建。
   * 等待可被 signal 中止（stop），中止按「未通过」返回，由 generation 守卫兜底。
   */
  private async verifyWithRetries(origin: string, generation: number, signal: AbortSignal): Promise<boolean> {
    // 探针与连接器同路径：有代理桥时也经 ProxyAgent 走代理（attemptProxyUrl 本轮已定）。
    const verify = this.options.verify ?? ((target: string) => verifyPublicGateway(target, gatewayId(), { proxyUrl: this.attemptProxyUrl }));
    const waits = this.options.verifyWaitsMs ?? VERIFY_WAITS_MS;
    const deadline = Date.now() + (this.options.verifyBudgetMs ?? VERIFY_BUDGET_MS);
    for (const [index, wait] of waits.entries()) {
      if (index > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        if (!await pause(Math.min(wait, remaining), signal)) return false;
      }
      if (!this.current(generation)) return false;
      if (await verify(origin)) return true;
    }
    return false;
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
    const secrets = [this.settings.token, this.attemptProxyUrl ?? ""];
    const stopStartedAt = Date.now();
    this.writeDiagnostic(randomUUID(), secrets, { stage: "stopping", outcome: "started" });
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
      // 桥的关闭同样是硬要求：留着会让本地端口泄漏，下一次 start 可能连不上旧桥。
      if (!await this.stopBridge()) closed = false;
      try { writePublicAccessOrigin(null, this.settingsPath()); } catch { closed = false; }
      if (generation === this.generation) {
        this.stopUnconfirmed = !closed;
        this.status = {
          publicUrl: null,
          phase: null,
          error: closed ? null : "stop",
          state: closed ? (this.isConfigured() ? "disabled" : "unconfigured") : "failed",
          domainBinding: null,
          restoredByAutoStart: false,
        };
      }
    } finally {
      this.stopping--;
    }
    this.writeDiagnostic(randomUUID(), secrets, {
      stage: "stopping",
      outcome: closed ? "succeeded" : "failed",
      ...(closed ? {} : { reason: "shutdown_unconfirmed" }),
      durationMs: Date.now() - stopStartedAt,
    });
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
