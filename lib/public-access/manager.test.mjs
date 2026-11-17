import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// manager.ts 现在依赖 lib/network-proxy.ts（读代理设置起桥），而后者用无扩展名的相对
// 导入，node 原生 TS 加载解析不了 —— 用 jiti（本仓 network-proxy.test.mjs 的既定做法）。
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { "@": process.cwd() } });
const { PublicAccessManager, classifyPublicAccessError } = await jiti.import("./manager.ts");
const settings = await jiti.import("./settings.ts");
const networkProxy = await jiti.import("../network-proxy.ts");

const PORT = 30141;
const ENV = { PI_WEB_PASSWORD: "pw" };

// start()/restore() 的密码判定现在是双来源（注入 env 或进程环境/设置文件记录）。
// 统一在进程环境里给 env 来源；「未设密码」的用例在测试内临时删掉并隔离
// PI_CODING_AGENT_DIR，避免读到本机真实的密码记录。
const originalPassword = process.env.PI_WEB_PASSWORD;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_WEB_PASSWORD = "pw";
process.env.PI_CODING_AGENT_DIR = join(tmpdir(), `pi-pa-manager-test-${process.pid}-empty`);
after(() => {
  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "pi-pa-manager-"));
  mkdirSync(join(dir, "pi-web"), { recursive: true });
  return join(dir, "pi-web", "settings.json");
}

function seed(path, patch = {}) {
  return settings.writePublicAccessConfig(
    { ...settings.readPublicAccessConfig(path), mode: "quick", autoStart: false, ...patch },
    path,
  );
}

function fakeTunnel({ url = "https://calm-river.trycloudflare.com", failStop = false, routes = [], routeQueue = null } = {}) {
  const exits = new Set();
  return {
    url,
    stopCalls: 0,
    async stop() {
      this.stopCalls += 1;
      if (failStop) throw new Error("cannot stop the connector");
    },
    async publishedRoutes() {
      // routeQueue：逐次交不同的推送；routes：恒定返回（null = 始终没推送）。
      if (routeQueue) return routeQueue.length > 1 ? routeQueue.shift() : routeQueue[0];
      return routes;
    },
    onExit(callback) { exits.add(callback); return () => exits.delete(callback); },
    emitExit() { for (const callback of [...exits]) callback({ code: 0, signal: null }); },
  };
}

function manager(path, extra = {}) {
  const tunnel = extra.tunnel ?? fakeTunnel();
  return {
    tunnel,
    instance: new PublicAccessManager({
      settingsPath: path,
      localPort: () => PORT,
      env: ENV,
      startTunnel: async () => tunnel,
      verify: async () => true,
      ...extra.overrides,
    }),
  };
}

test("happy path：启动 → 验证 → online，并把 origin 写进设置文件", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  const { instance } = manager(path);

  const status = await instance.start();
  assert.equal(status.state, "online");
  assert.equal(status.publicUrl, "https://calm-river.trycloudflare.com");
  assert.equal(status.domainBinding, null, "quick 模式没有域名绑定概念，状态恒为 null");
  assert.equal(settings.readPublicAccessOrigin(path), "https://calm-river.trycloudflare.com");
  assert.equal(instance.getView().tokenSet, false);

  await instance.stop();
  assert.equal(instance.getStatus().state, "disabled");
  assert.equal(settings.readPublicAccessOrigin(path), null, "停止后 origin 必须清空");
});

test("没设 web 密码时不启动（也不写 origin）", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  const { instance } = manager(path, { overrides: { env: {} } });
  const previous = process.env.PI_WEB_PASSWORD;
  try {
    delete process.env.PI_WEB_PASSWORD;
    // 文案指向设置页而不是环境变量：设置页存的密码同样算数。
    assert.throws(() => instance.start(), /web password/i);
    assert.throws(() => instance.start(), /Settings/);
  } finally {
    process.env.PI_WEB_PASSWORD = previous ?? "pw";
  }
  assert.equal(settings.readPublicAccessOrigin(path), null);
});

test("env 没给密码但设置文件里有记录时可以启动", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  const { instance } = manager(path, { overrides: { env: {} } });
  const { writeWebPasswordRecord, clearWebPasswordRecord } = await jiti.import("../web-password-store.ts");
  const previous = process.env.PI_WEB_PASSWORD;
  try {
    delete process.env.PI_WEB_PASSWORD;
    writeWebPasswordRecord("file-secret");
    const status = await instance.start();
    assert.equal(status.state, "online", "设置文件来源的密码同样放行隧道");
    await instance.stop();
  } finally {
    process.env.PI_WEB_PASSWORD = previous ?? "pw";
    clearWebPasswordRecord();
  }
});

test("公网校验失败 → 归类 network 并进入重连，且 origin 被清掉", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  let verifyCalls = 0;
  // 默认节奏 [0,2s,4s,8s,15s] 会拖垮单测：注入等长但等值极小的间隔，节奏结构不变。
  const { instance } = manager(path, { overrides: { verifyWaitsMs: [0, 5, 5], verify: async () => { verifyCalls += 1; return false; } } });
  const status = await instance.start();
  assert.equal(status.state, "reconnecting", "network 类错误会退避重试");
  assert.equal(status.error, "network");
  assert.equal(instance.getStatus().publicUrl, null);
  assert.equal(verifyCalls, 3, "分间隔节奏里的三次校验");
  assert.equal(settings.readPublicAccessOrigin(path), null);
  await instance.stop();
});

test("校验分间隔重试：DNS 传播期晚成功也算过（不再立即三连败重建）", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  let verifyCalls = 0;
  const { instance } = manager(path, { overrides: {
    verifyWaitsMs: [0, 5, 10],
    verify: async () => { verifyCalls += 1; return verifyCalls >= 3; },
  } });
  const status = await instance.start();
  assert.equal(status.state, "online", "间隔后的第三次校验通过即算 online");
  assert.equal(status.publicUrl, "https://calm-river.trycloudflare.com");
  assert.equal(verifyCalls, 3);
  await instance.stop();
});

test("named + 自定义域名：推送规则匹配 → bound，publicUrl 用自定义域名", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path, { mode: "named", token: "x".repeat(40), customUrl: "https://pi.example.com" });
  const { instance } = manager(path, {
    tunnel: fakeTunnel({ url: null, routes: [{ hostname: "pi.example.com", service: "http://127.0.0.1:30141" }] }),
  });
  const status = await instance.start();
  assert.equal(status.state, "online");
  assert.equal(status.publicUrl, "https://pi.example.com", "固定域名优先于其它推送路由");
  assert.equal(status.domainBinding?.state, "bound");
  assert.equal(status.domainBinding?.reason, null);
  assert.equal(settings.readPublicAccessOrigin(path), "https://pi.example.com");
  await instance.stop();
});

test("named + 自定义域名：先推别的域名 → 未绑定指引，随后推送到达 → 自动绑定", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path, { mode: "named", token: "x".repeat(40), customUrl: "https://pi.example.com" });
  const { instance } = manager(path, {
    tunnel: fakeTunnel({
      url: null,
      routeQueue: [
        [{ hostname: "other.example.com", service: "http://127.0.0.1:30141" }],
        [{ hostname: "pi.example.com", service: "http://127.0.0.1:30141" }],
      ],
    }),
  });
  const early = await instance.start();
  assert.equal(early.state, "connecting", "首次 routeWait 竞态先返回");
  assert.equal(early.domainBinding?.state, "unbound");
  assert.equal(early.domainBinding?.reason, "other-hostnames", "只推了别的域名 → 未绑定 + 指引");
  // 用户到 Cloudflare 控制台补路由后的推送到达 → 无需重启隧道自动绑定。
  await new Promise((resolve) => setTimeout(resolve, 30));
  const final = instance.getStatus();
  assert.equal(final.state, "online");
  assert.equal(final.publicUrl, "https://pi.example.com");
  assert.equal(final.domainBinding?.state, "bound");
  await instance.stop();
});

test("named + 自定义域名：预算内没绑定 → 超时结论（failed(route) + timeout）", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path, { mode: "named", token: "x".repeat(40), customUrl: "https://pi.example.com" });
  const { instance } = manager(path, {
    tunnel: fakeTunnel({ url: null, routes: null }),
    overrides: { bindingBudgetMs: 40 },
  });
  await instance.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const status = instance.getStatus();
  assert.equal(status.state, "failed");
  assert.equal(status.error, "route");
  assert.equal(status.domainBinding?.state, "timeout", "超时要有明确提示");
  assert.equal(status.publicUrl, null);
  assert.equal(settings.readPublicAccessOrigin(path), null);
});

test("restore 成功后标注 restoredByAutoStart（autoStart 恢复已有补状态文案的依据）", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path, { autoStart: true, consentVersion: settings.PUBLIC_ACCESS_CONSENT_VERSION });
  const { instance } = manager(path);
  await instance.restore();
  assert.equal(instance.getStatus().state, "online");
  assert.equal(instance.getStatus().restoredByAutoStart, true);
  await instance.stop();
  assert.equal(instance.getStatus().restoredByAutoStart, false, "停止后清掉标注");
});

test("连接器异常退出且仍想在线 → 进入 reconnecting", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  const { instance, tunnel } = manager(path);
  await instance.start();
  tunnel.emitExit();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(instance.getStatus().state, "reconnecting");
  await instance.stop();
  assert.equal(instance.getStatus().state, "disabled");
});

test("停止无法确认 → failed(stop)，且阻止再次启动", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  const { instance } = manager(path, { tunnel: fakeTunnel({ failStop: true }) });
  await instance.start();
  const status = await instance.stop();
  assert.equal(status.state, "failed");
  assert.equal(status.error, "stop");
  await assert.rejects(instance.start(), /stop must be confirmed/);
});

test("configure 会停隧道并把同意版本归零", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  const { instance, tunnel } = manager(path);
  await instance.start();
  const current = settings.readPublicAccessConfig(path);
  const view = await instance.configure({ ...current, enabled: true, mode: "named", token: "x".repeat(40) });
  assert.equal(view.consentVersion, 0);
  assert.equal(view.mode, "named");
  assert.equal(tunnel.stopCalls, 1);
  assert.equal(settings.readPublicAccessOrigin(path), null);
});

test("restore：只有 autoStart + 同意过 + 有密码才自启", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));

  seed(path, { autoStart: false });
  const idle = manager(path).instance;
  await idle.restore();
  assert.equal(idle.getStatus().state, "disabled");

  seed(path, { autoStart: true });
  const noConsent = manager(path).instance;
  await noConsent.restore();
  assert.equal(noConsent.getStatus().state, "disabled", "没同意过不启动");

  seed(path, { autoStart: true, consentVersion: settings.PUBLIC_ACCESS_CONSENT_VERSION });
  const restored = manager(path).instance;
  await restored.restore();
  assert.equal(restored.getStatus().state, "online");
  await restored.stop();

  const withoutPassword = manager(path, { overrides: { env: {} } }).instance;
  // 双来源判定：env 注入为空之外，进程环境的 env 来源也要拿掉，否则回落到它。
  const previous = process.env.PI_WEB_PASSWORD;
  try {
    delete process.env.PI_WEB_PASSWORD;
    await withoutPassword.restore();
    assert.equal(withoutPassword.getStatus().state, "disabled", "没密码不自动开洞");
  } finally {
    process.env.PI_WEB_PASSWORD = previous ?? "pw";
  }
});

test("classifyPublicAccessError：受控 code 原样返回，其余按文案归类", () => {
  assert.equal(classifyPublicAccessError({ code: "token" }), "token");
  assert.equal(classifyPublicAccessError({ code: "proxy" }), "proxy");
  assert.equal(classifyPublicAccessError(new Error("EADDRINUSE")), "configuration");
  assert.equal(classifyPublicAccessError(new Error("socket hang up")), "network");
});

test("有代理：起桥并把句柄交给 tunnel；stop 后桥被关闭", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  // 设置文件里的 manual 代理就是 manager 该读到的来源。
  networkProxy.writeNetworkProxySettings({ mode: "manual", url: "http://127.0.0.1:3128" }, path);

  let stopCalls = 0;
  let started = 0;
  let seenBridge;
  const bridge = {
    edgeAddresses: ["127.0.0.1:1", "127.0.0.1:2", "127.0.0.1:3", "127.0.0.1:4"],
    quickServiceUrl: "http://127.0.0.1:5/random",
    async stop() { stopCalls += 1; },
  };
  const tunnel = fakeTunnel();
  const instance = new PublicAccessManager({
    settingsPath: path,
    localPort: () => PORT,
    env: ENV,
    startProxyTransport: async (url) => { started += 1; assert.equal(url, "http://127.0.0.1:3128"); return bridge; },
    startTunnel: async (options) => { seenBridge = options.proxyBridge; return tunnel; },
    verify: async () => true,
  });

  const status = await instance.start();
  assert.equal(status.state, "online");
  assert.equal(started, 1, "配了 manual 代理就起一次桥");
  assert.equal(seenBridge, bridge, "桥句柄传给了 tunnel");
  assert.equal(stopCalls, 0, "online 期间桥保持开着");

  await instance.stop();
  assert.equal(stopCalls, 1, "stop 后桥被关闭，端口不泄漏");
});

test("起桥期间被 stop：桥照样被关，句柄不落字段（不泄漏 listener）", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  networkProxy.writeNetworkProxySettings({ mode: "manual", url: "http://127.0.0.1:3128" }, path);

  let stopCalls = 0;
  let releaseBridge;
  const bridge = {
    edgeAddresses: ["127.0.0.1:1"],
    quickServiceUrl: "http://127.0.0.1:5/random",
    async stop() { stopCalls += 1; },
  };
  const instance = new PublicAccessManager({
    settingsPath: path,
    localPort: () => PORT,
    env: ENV,
    // 桥「起得慢」：先挂住，等测试把 stop() 跑完再返回句柄。
    startProxyTransport: () => new Promise((resolve) => { releaseBridge = () => resolve(bridge); }),
    startTunnel: async () => { throw new Error("generation 已过期，不该起连接器"); },
    verify: async () => true,
  });

  const starting = instance.start();
  // 等到 startProxyTransport 已经在等（releaseBridge 赋值），再并发 stop。
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(typeof releaseBridge, "function", "startProxyTransport 已经进入");
  await instance.stop();
  releaseBridge();
  await starting;

  assert.equal(stopCalls, 1, "stop 先到时桥还没落字段，返回后必须自己关掉");
});

test("直连（no proxy）：不起桥、不传句柄", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  let started = 0;
  let seenBridge = "unset";
  const instance = new PublicAccessManager({
    settingsPath: path,
    localPort: () => PORT,
    env: ENV,
    startProxyTransport: async () => { started += 1; throw new Error("should not start"); },
    startTunnel: async (options) => { seenBridge = options.proxyBridge; return fakeTunnel(); },
    verify: async () => true,
  });
  const status = await instance.start();
  assert.equal(status.state, "online");
  assert.equal(started, 0, "没配代理不起桥");
  assert.equal(seenBridge, undefined, "直连时 tunnel 收不到桥句柄");
  await instance.stop();
});

test("桥起不来 → 归 proxy，且不走 network 重试", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  networkProxy.writeNetworkProxySettings({ mode: "manual", url: "http://127.0.0.1:3128" }, path);
  const instance = new PublicAccessManager({
    settingsPath: path,
    localPort: () => PORT,
    env: ENV,
    startProxyTransport: async () => { throw new Error("cannot bind the proxy bridge"); },
    startTunnel: async () => { throw new Error("should not spawn a connector"); },
    verify: async () => true,
    verifyWaitsMs: [0, 5, 5],
  });
  const status = await instance.start();
  assert.equal(status.error, "proxy", "桥失败归 proxy");
  assert.equal(status.state, "failed", "proxy 不重试（network 才会进入 reconnecting）");
  assert.equal(status.publicUrl, null);
  assert.equal(settings.readPublicAccessOrigin(path), null);
  // 给重试调度一个机会：proxy 类不该排任何重试。
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(instance.getStatus().state, "failed", "仍停在 failed，没有重连");
});

test("status.diagnostics 带出最近诊断（含 online 一步）", async (t) => {
  const path = tempPath();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  seed(path);
  const { clearDiagnostics } = await jiti.import("./diagnostics.ts");
  clearDiagnostics();
  const { instance } = manager(path);
  const status = await instance.start();
  assert.ok(Array.isArray(status.diagnostics), "status 带 diagnostics 数组");
  assert.ok(status.diagnostics.length > 0 && status.diagnostics.length <= 20, "最多 20 条");
  assert.ok(status.diagnostics.some((event) => event.stage === "online" && event.outcome === "succeeded"), "含 online/succeeded");
  assert.ok(status.diagnostics.some((event) => event.stage === "preparing"), "含 preparing");
  await instance.stop();
});
