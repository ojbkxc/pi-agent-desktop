import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import * as undici from "undici";

const { verifyPublicGateway, gatewayId } = await import("./gateway.ts");

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

test("manual 代理模式下探针直连：坏代理与被替换的 globalThis.fetch 都不影响探针", async (t) => {
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
  // 模拟 manual 代理模式（lib/network-proxy.ts 写 HTTP(S)_PROXY，lib/http-dispatcher.ts
  // 装 EnvHttpProxyAgent 并把 globalThis.fetch 换成 undici.fetch）：两条路都堵死，
  // 探针仍须成功——它必须与 cloudflared（剥代理 env 直连）同路径。
  globalThis.fetch = async () => { throw new Error("proxy down"); };
  undici.setGlobalDispatcher(proxyAgent);
  try {
    assert.equal(
      await verifyPublicGateway(`http://127.0.0.1:${port}`, "gw-proxy"),
      true,
      "探针必须直连：代理坏时隧道仍通（cloudflared 直连），探针不得假失败",
    );
  } finally {
    globalThis.fetch = originalFetch;
    undici.setGlobalDispatcher(originalDispatcher);
    await proxyAgent.close();
  }
});
