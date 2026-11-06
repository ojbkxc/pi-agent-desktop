import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

const { startCloudflareTunnel, CloudflareTunnelError, cloudflareProcessEnvironment, readPublishedRoutes, publishedGatewayOrigin } =
  await import("./tunnel.ts");

const TUNNEL_ID = "12345678-1234-1234-1234-123456789012";
const TOKEN = Buffer.from(JSON.stringify({ a: "acct", t: TUNNEL_ID, s: "c2VjcmV0" })).toString("base64");
const BINARY = process.execPath; // 只需「存在且可执行」

/** 缓冲型假流：监听器挂上之前写入的数据会在挂上时补发，消除启动竞态。 */
function stream() {
  const emitter = new EventEmitter();
  const buffered = [];
  const originalOn = emitter.on.bind(emitter);
  emitter.on = (event, handler) => {
    if (event === "data" && buffered.length) {
      for (const chunk of buffered.splice(0)) handler(chunk);
    }
    return originalOn(event, handler);
  };
  emitter.push = (chunk) => {
    if (emitter.listenerCount("data") > 0) emitter.emit("data", chunk);
    else buffered.push(chunk);
  };
  return emitter;
}

/** 假的 cloudflared 子进程：手动喂日志；默认收到信号就退出（可关掉以测「关不掉」）。 */
function fakeChild({ exitOnKill = true } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = stream();
  child.stderr = stream();
  child.killed = [];
  child.kill = (signal) => {
    child.killed.push(signal);
    if (exitOnKill) setImmediate(() => child.emit("exit", 0, signal));
    return true;
  };
  return child;
}

function deps(child, extra = {}) {
  const spawned = [];
  return {
    spawned,
    deps: {
      binaryPath: BINARY,
      timeoutMs: 500,
      stopTimeoutMs: 20,
      spawn: (binary, args, options) => { spawned.push({ binary, args, options }); return child; },
      env: { PATH: "/usr/bin", HTTP_PROXY: "http://corp:8080", TUNNEL_TOKEN: "inherited", KEEP: "yes" },
      ...extra,
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const log = (child, text) => { child.stdout.push(Buffer.from(text)); child.stderr.push(Buffer.from(text)); };

test("参数与环境：token 只走 env，代理/云火山变量被剔除", async () => {
  const child = fakeChild();
  const { spawned, deps: d } = deps(child);
  const pending = startCloudflareTunnel({ mode: "named", localPort: 30141, token: TOKEN }, d);
  log(child, "Registered tunnel connection\n");
  const tunnel = await pending;
  const call = spawned[0];
  assert.equal(call.binary, BINARY);
  assert.deepEqual(call.args.slice(0, 5), ["--no-autoupdate", "--config", call.args[2], "tunnel", "--metrics"]);
  assert.equal(call.args.at(-1), "run", "named 用 run 而不是 --url");
  assert.equal(call.args.includes(TOKEN), false, "token 绝不能出现在 argv");
  assert.equal(call.options.env.TUNNEL_TOKEN, TOKEN);
  assert.equal(call.options.env.HTTP_PROXY, undefined);
  assert.equal(call.options.env.KEEP, "yes");
  assert.equal(call.options.env.NO_AUTOUPDATE, "true");
  assert.equal(call.options.windowsHide, true);
  await tunnel.stop();
});

test("就绪需要「注册成功」且「地址已打印」两个条件", async () => {
  const child = fakeChild();
  const { deps: d } = deps(child);
  const pending = startCloudflareTunnel({ mode: "quick", localPort: 30141 }, d);
  let settled = false;
  void pending.then(() => { settled = true; });
  await settle();
  log(child, "https://calm-river-1234.trycloudflare.com\n");
  await settle();
  assert.equal(settled, false, "只打印地址不算就绪");
  log(child, "Registered tunnel connection connIndex=0\n");
  const tunnel = await pending;
  assert.equal(tunnel.url, "https://calm-river-1234.trycloudflare.com");
  await tunnel.stop();
});

test("api.trycloudflare.com 不会被当成入口地址", async () => {
  const child = fakeChild();
  const { deps: d } = deps(child);
  const pending = startCloudflareTunnel({ mode: "quick", localPort: 30141 }, d);
  await settle();
  log(child, "https://api.trycloudflare.com/health\n");
  log(child, "Registered tunnel connection\n");
  await assert.rejects(pending, (error) => error.name === "CloudflareTunnelError" && error.code === "network");
});

test("两次边缘拒绝 → token 错误", async () => {
  const child = fakeChild();
  const { deps: d } = deps(child);
  const pending = startCloudflareTunnel({ mode: "named", localPort: 30141, token: TOKEN }, d);
  await settle();
  log(child, "Register tunnel error from server side\n");
  log(child, "Register tunnel error from server side\n");
  await assert.rejects(pending, (error) => error.code === "token");
});

test("命名隧道的推送路由：解析 Go 转义 JSON，并按自定义域名优先选 origin", async () => {
  // 日志里 config= 后面跟的是 Go 的 strconv.Quote：外层一层 JSON，内层才是配置 JSON。
  const goQuoted = JSON.stringify(JSON.stringify({
    ingress: [
      { hostname: "pi.example.com", service: "http://127.0.0.1:30141" },
      { hostname: "other.example.com", service: "http://127.0.0.1:9999" },
      { service: "http_status:404" },
    ],
  }));
  const routes = readPublishedRoutes(`INF Updated to new configuration config=${goQuoted}`);
  assert.deepEqual(routes.slice(0, 2), [
    { hostname: "pi.example.com", service: "http://127.0.0.1:30141" },
    { hostname: "other.example.com", service: "http://127.0.0.1:9999" },
  ]);
  assert.equal(readPublishedRoutes("INF nothing here"), null);
  assert.equal(publishedGatewayOrigin(routes, 30141), "https://pi.example.com");
  assert.equal(publishedGatewayOrigin(routes, 30141, "https://pi.example.com"), "https://pi.example.com");
  assert.equal(publishedGatewayOrigin(routes, 30141, "https://custom.example.com"), "https://pi.example.com");
  assert.equal(publishedGatewayOrigin([{ hostname: "*.example.com", service: "http://127.0.0.1:30141" }], 30141, "https://custom.example.com"), "https://custom.example.com");
  assert.equal(publishedGatewayOrigin(routes, 30000), null);
});

test("stop：SIGTERM 后正常退出，不升级到 SIGKILL", async () => {
  const child = fakeChild();
  const { deps: d } = deps(child);
  const pending = startCloudflareTunnel({ mode: "quick", localPort: 30141 }, d);
  await settle();
  log(child, "https://calm-river-1234.trycloudflare.com\n");
  log(child, "Registered tunnel connection\n");
  const tunnel = await pending;
  const stopping = tunnel.stop();
  await settle();
  child.emit("exit", 0, null);
  await stopping;
  assert.deepEqual(child.killed, ["SIGTERM"]);
});

test("非 stopping 的退出会通知观察者", async () => {
  const child = fakeChild();
  const { deps: d } = deps(child);
  const pending = startCloudflareTunnel({ mode: "quick", localPort: 30141 }, d);
  await settle();
  log(child, "https://calm-river-1234.trycloudflare.com\n");
  log(child, "Registered tunnel connection\n");
  const tunnel = await pending;
  let exits = 0;
  tunnel.onExit(() => { exits += 1; });
  child.emit("exit", 1, null);
  await settle();
  assert.equal(exits, 1);
});

test("stop：进程不退出时 SIGKILL 仍未确认 → runtime 错误且带 retryStop", async () => {
  const child = fakeChild({ exitOnKill: false });
  const { deps: d } = deps(child);
  const pending = startCloudflareTunnel({ mode: "quick", localPort: 30141 }, d);
  await settle();
  log(child, "https://calm-river-1234.trycloudflare.com\n");
  log(child, "Registered tunnel connection\n");
  const tunnel = await pending;
  await assert.rejects(tunnel.stop(), (error) => {
    assert.ok(error instanceof CloudflareTunnelError);
    assert.equal(error.code, "runtime");
    assert.equal(typeof error.retryStop, "function");
    return true;
  });
  assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL"]);
});

test("找不到二进制 / 非法配置在 spawn 之前就失败", async () => {
  await assert.rejects(
    startCloudflareTunnel({ mode: "quick", localPort: 30141 }, { binaryPath: "/nope/cloudflared" }),
    (error) => error.code === "runtime",
  );
  await assert.rejects(
    startCloudflareTunnel({ mode: "named", localPort: 30141, token: "" }, { binaryPath: BINARY }),
    (error) => error.code === "token",
  );
  await assert.rejects(
    startCloudflareTunnel({ mode: "quick", localPort: 80 }, { binaryPath: BINARY }),
    (error) => error.code === "configuration",
  );
});

test("cloudflareProcessEnvironment 剔除代理与云火山变量", () => {
  const env = cloudflareProcessEnvironment({ HTTP_PROXY: "x", all_proxy: "y", NO_PROXY: "z", TUNNEL_TOKEN: "t", CLOUDFLARED_X: "1", PATH: "/bin" }, "/tmp/home", "tok");
  assert.deepEqual(env, { PATH: "/bin", HOME: "/tmp/home", USERPROFILE: "/tmp/home", XDG_CONFIG_HOME: "/tmp/home", NO_AUTOUPDATE: "true", TUNNEL_TOKEN: "tok" });
});
