import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createJiti } from "jiti";
import * as undici from "undici";

// gateway.ts 依赖 lib/network-proxy.ts（探针与连接器同路径），而后者用的是无扩展名的
// 相对导入，node 原生 TS 加载解析不了。用 jiti（本仓 network-proxy.test.mjs 的既定做法）。
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { "@": process.cwd() } });
const { verifyPublicGateway, gatewayId } = await jiti.import("./gateway.ts");

/** 起一个本地 http 服务（探针本身不校验 scheme，测试用 http 起真实端口即可）。 */
function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("探针校验：/health 回 status=ok 且 gatewayId 相同才算过", async (t) => {
  const { server, port } = await listen((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", gatewayId: "gw-1" }));
  });
  t.after(() => close(server));
  assert.equal(gatewayId(), gatewayId(), "网关身份在进程内稳定");
  assert.equal(await verifyPublicGateway(`http://127.0.0.1:${port}`, "gw-1"), true);
  assert.equal(await verifyPublicGateway(`http://127.0.0.1:${port}`, "gw-2"), false, "别的进程的 id 不算数");
  assert.equal(await verifyPublicGateway(`http://127.0.0.1:${port}`, ""), false);
});

test("探针失败口径：非 2xx / 非 JSON / 字段不对 / 超大 body 一律失败", async (t) => {
  const notFound = await listen((req, res) => { res.statusCode = 404; res.end("nope"); });
  t.after(() => close(notFound.server));
  assert.equal(await verifyPublicGateway(`http://127.0.0.1:${notFound.port}`, "gw-1"), false, "非 2xx");

  const html = await listen((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<h1>ok</h1>");
  });
  t.after(() => close(html.server));
  assert.equal(await verifyPublicGateway(`http://127.0.0.1:${html.port}`, "gw-1"), false, "非 JSON content-type");

  const wrong = await listen((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  t.after(() => close(wrong.server));
  assert.equal(await verifyPublicGateway(`http://127.0.0.1:${wrong.port}`, "gw-1"), false, "缺 status/gatewayId");

  const huge = await listen((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", gatewayId: "gw-1", pad: "x".repeat(8192) }));
  });
  t.after(() => close(huge.server));
  assert.equal(await verifyPublicGateway(`http://127.0.0.1:${huge.port}`, "gw-1"), false, "body 超过上限");
});

test("有代理时探针走 ProxyAgent（注入 fetch 断言 dispatcher 存在）", async () => {
  let seenDispatcher;
  const fakeFetch = async (_url, init) => {
    seenDispatcher = init.dispatcher;
    return new Response(JSON.stringify({ status: "ok", gatewayId: "gw-proxy" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const ok = await verifyPublicGateway("https://pi.example.com", "gw-proxy", {
    proxyUrl: "http://alice:s3cr3t@127.0.0.1:3128",
    fetch: fakeFetch,
  });
  assert.equal(ok, true);
  assert.ok(seenDispatcher instanceof undici.ProxyAgent, "有代理时 dispatcher 是 ProxyAgent");
});

test("无代理时探针走直连 dispatcher（不是 ProxyAgent）", async () => {
  let seenDispatcher;
  const fakeFetch = async (_url, init) => {
    seenDispatcher = init.dispatcher;
    return new Response(JSON.stringify({ status: "ok", gatewayId: "gw" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  assert.equal(await verifyPublicGateway("https://pi.example.com", "gw", { fetch: fakeFetch }), true);
  assert.equal(seenDispatcher instanceof undici.ProxyAgent, false, "无代理时走直连 Agent");
});

test("端到端：经 ProxyAgent 打到本地假代理，凭据在 Proxy-Authorization 里（不进 URL）", async (t) => {
  const seen = [];
  const { server, port } = await listen((req, res) => {
    seen.push({ url: req.url, auth: req.headers["proxy-authorization"] ?? null });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", gatewayId: "gw-proxy" }));
  });
  t.after(() => close(server));

  // 目标端口无需真的监听：假代理直接应答（只证明请求确实经过代理、且带了认证头）。
  const ok = await verifyPublicGateway("http://127.0.0.1:59999", "gw-proxy", {
    proxyUrl: `http://alice:s3cr3t@127.0.0.1:${port}`,
  });
  assert.equal(ok, true, "经代理拿到 health");
  assert.equal(seen.length, 1, "请求经过代理");
  assert.equal(seen[0].url, "http://127.0.0.1:59999/health", "http 目标走 absolute-form");
  assert.equal(seen[0].auth, `Basic ${Buffer.from("alice:s3cr3t").toString("base64")}`, "凭据用 Proxy-Authorization 递上去");
});

test("无代理桥时探针直连：坏代理与被替换的 globalThis.fetch 都不影响探针", async (t) => {
  const { server, port } = await listen((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", gatewayId: "gw-proxy" }));
  });
  t.after(() => close(server));

  // 找一个肯定没人监听的端口当死代理。
  const dead = await listen((req, res) => res.end());
  await close(dead.server);

  const originalFetch = globalThis.fetch;
  const originalDispatcher = undici.getGlobalDispatcher();
  const proxyAgent = new undici.ProxyAgent({ uri: `http://127.0.0.1:${dead.port}` });
  // 模拟没有代理桥时的进程状态（lib/network-proxy.ts 写 HTTP(S)_PROXY、lib/http-dispatcher.ts
  // 装 EnvHttpProxyAgent 并把 globalThis.fetch 换成 undici.fetch）：两条全局路都堵死，
  // 不传 proxyUrl 的探针仍须成功——它有自己的显式 dispatcher，不被全局状态带偏。
  globalThis.fetch = async () => { throw new Error("proxy down"); };
  undici.setGlobalDispatcher(proxyAgent);
  try {
    assert.equal(
      await verifyPublicGateway(`http://127.0.0.1:${port}`, "gw-proxy"),
      true,
      "无代理桥时探针直连：不得被全局代理 dispatcher / 被替换的 fetch 带偏",
    );
  } finally {
    globalThis.fetch = originalFetch;
    undici.setGlobalDispatcher(originalDispatcher);
    await proxyAgent.close();
  }
});
