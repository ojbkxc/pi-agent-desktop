import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import test from "node:test";

// cloudflare-proxy.ts 只依赖 ./diagnostics.ts（无更深的相对导入链），可直接用 node 原生
// TS 加载。
const { startCloudflareProxyTransport } = await import("./cloudflare-proxy.ts");

/** 起一个监听 127.0.0.1 的 server，返回它实际占用的端口。 */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("listen failed"));
      else resolve(address.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    if (server instanceof http.Server) server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** 假的回环 echo 服务：原样回吐收到的字节，模拟“经代理到达的边缘”。 */
function echoServer() {
  return net.createServer((socket) => { socket.pipe(socket); });
}

/**
 * 假的 HTTP 代理：只处理 CONNECT。把 CONNECT 的 authority 忽略掉，统一转到 `target`
 * （echo 服务），并记录每次 CONNECT 的请求行与 Proxy-Authorization —— 用来证明桥真的
 * 走了 CONNECT、并且凭据是用 Proxy-Authorization 头递上去的。
 */
function fakeProxy(target) {
  const connects = [];
  const server = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
  server.on("connect", (req, clientSocket, head) => {
    connects.push({ url: req.url, auth: req.headers["proxy-authorization"] ?? null });
    const upstream = net.connect({ host: "127.0.0.1", port: target }, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  return { server, connects };
}

/** 从一个 TCP 客户端的 socket 读到至少 `length` 字节（或超时）。 */
function readAtLeast(socket, length, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(new Error("timed out waiting for socket data")); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); socket.off("data", onData); socket.off("error", onError); };
    const onError = (error) => { cleanup(); reject(error); };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= length) { cleanup(); resolve(buffer); }
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function connectClient(address) {
  const match = /^(?:127\.0\.0\.1|localhost):(\d+)$/.exec(address);
  assert.ok(match, `edge address must be loopback, got ${address}`);
  return net.connect({ host: "127.0.0.1", port: Number(match[1]) });
}

test("edge bridge：TCP 流量经代理 CONNECT 双向转发，凭据走 Proxy-Authorization", async (t) => {
  const echo = echoServer();
  const echoPort = await listen(echo);
  const proxy = fakeProxy(echoPort);
  const proxyPort = await listen(proxy.server);
  const transport = await startCloudflareProxyTransport(`http://user:supersecret@127.0.0.1:${proxyPort}`);
  t.after(async () => {
    await transport.stop();
    await closeServer(proxy.server);
    await closeServer(echo);
  });

  assert.equal(transport.edgeAddresses.length, 4, "四条独立的本地 edge 入口");
  assert.equal(new Set(transport.edgeAddresses).size, 4, "每条入口是独立的本地端口");

  const client = connectClient(transport.edgeAddresses[0]);
  await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
  client.write(Buffer.from("payload-via-proxy"));
  const echoed = await readAtLeast(client, "payload-via-proxy".length);
  assert.equal(echoed.toString(), "payload-via-proxy", "字节原样往返");
  client.destroy();

  assert.ok(proxy.connects.length >= 1, "桥确实向代理发起了 CONNECT");
  const expected = `Basic ${Buffer.from("user:supersecret").toString("base64")}`;
  assert.equal(proxy.connects[0].auth, expected, "凭据用 Proxy-Authorization: Basic 递上去");
  assert.match(proxy.connects[0].url, /:7844$/, "CONNECT 目标是边缘的 7844");
});

test("quick-service bridge：随机路径前缀挡住其它请求（404，且不触碰上游）", async (t) => {
  // quick 的 404 分支在连接上游之前就返回，所以这里给一个不会被真正使用的假代理即可。
  const echo = echoServer();
  const echoPort = await listen(echo);
  const proxy = fakeProxy(echoPort);
  const proxyPort = await listen(proxy.server);
  const transport = await startCloudflareProxyTransport(`http://127.0.0.1:${proxyPort}`);
  t.after(async () => {
    await transport.stop();
    await closeServer(proxy.server);
    await closeServer(echo);
  });

  const url = new URL(transport.quickServiceUrl);
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.pathname.length >= 40, "随机路径前缀足够长（randomBytes(24) 的 hex）");

  const request = (method, path, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: Number(url.port),
      method,
      path,
      headers: { host: `127.0.0.1:${url.port}`, ...headers },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.once("error", reject);
    req.end();
  });

  assert.equal(await request("POST", "/wrong-prefix/tunnel"), 404, "错误前缀被挡");
  assert.equal(await request("GET", `${url.pathname}/tunnel`), 404, "非 POST 被挡");
  assert.equal(await request("POST", `${url.pathname}/tunnel`, { origin: "https://hostile.example" }), 404, "带 Origin 被挡");
  assert.equal(proxy.connects.length, 0, "被挡的请求从未触碰上游代理");
});

test("代理不通：给出清楚的 reason，且 stop() 幂等", async (t) => {
  // 先 listen 再关掉，拿到一个「肯定没人监听」的端口当死代理。
  const dead = net.createServer();
  const deadPort = await listen(dead);
  await closeServer(dead);

  const events = [];
  const transport = await startCloudflareProxyTransport(`http://user:secret@127.0.0.1:${deadPort}`, {
    connectTimeoutMs: 2_000,
    onDiagnostic: (event) => events.push(event),
  });
  // 起桥本身成功（监听在回环上）；真正的失败发生在有人连进来、桥去 CONNECT 时才暴露。
  const client = connectClient(transport.edgeAddresses[1]);
  client.on("error", () => {});
  await new Promise((resolve) => {
    client.once("close", resolve);
    client.once("connect", () => resolve());
    setTimeout(resolve, 3_000);
  });
  client.destroy();

  // 等诊断事件落下来。
  for (let i = 0; i < 50 && !events.some((event) => event.stage === "proxy_connect" && event.outcome === "failed"); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const failed = events.find((event) => event.stage === "proxy_connect" && event.outcome === "failed");
  assert.ok(failed, "代理连不上要有一条 proxy_connect/failed 诊断");
  assert.match(String(failed.reason), /proxy_socket_error|proxy_closed|connect_timeout/, "reason 要能说明失败种类");

  // stop() 幂等：连调两次都应正常 resolve。
  await transport.stop();
  await transport.stop();
  t.after(() => closeServer(dead));
});

test("代理口令不出现在任何返回文本里", async () => {
  // 1) 原始诊断事件里不能出现口令；
  const events = [];
  const dead = net.createServer();
  const deadPort = await listen(dead);
  await closeServer(dead);
  const transport = await startCloudflareProxyTransport(`http://user:sekrit-passw0rd@127.0.0.1:${deadPort}`, {
    connectTimeoutMs: 1_000,
    onDiagnostic: (event) => events.push(event),
  });
  const client = connectClient(transport.edgeAddresses[0]);
  client.on("error", () => {});
  await new Promise((resolve) => {
    client.once("close", resolve);
    client.once("connect", () => resolve());
    setTimeout(resolve, 2_000);
  });
  client.destroy();
  await transport.stop();
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("sekrit-passw0rd"), false, "原始诊断事件不得含代理口令");
  assert.equal(serialized.includes(Buffer.from("user:sekrit-passw0rd").toString("base64")), false, "也不得含其 base64");

  // 2) 非法代理 URL 抛出的错误里也不能回显整串 URL（可能带口令）。
  await assert.rejects(
    startCloudflareProxyTransport(`socks5://user:sekrit-passw0rd@127.0.0.1:${deadPort}`),
    (error) => {
      assert.equal(String(error.message).includes("sekrit-passw0rd"), false);
      assert.equal(error.reason, "unsupported_proxy_protocol");
      return true;
    },
  );
});
