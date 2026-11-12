import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
];

test("configures HTTP_PROXY, HTTPS_PROXY, and NO_PROXY for global fetch", async (t) => {
  const originalEnv = new Map(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];

  const connectTargets = [];
  const forwardedRequests = [];
  const proxy = createServer((req, res) => {
    forwardedRequests.push(`${req.method} ${req.url}`);
    res.writeHead(204, { Connection: "close" });
    res.end();
  });
  proxy.on("connect", (req, socket) => {
    connectTargets.push(req.url);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");

  t.after(async () => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise((resolve, reject) => {
      proxy.close((error) => error ? reject(error) : resolve());
    });
  });

  const address = proxy.address();
  assert.ok(address && typeof address === "object");
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.NO_PROXY = "bypass.invalid";

  const jiti = createJiti(import.meta.url);
  const { installHttpDispatcher, applyGlobalFetchForProxy } = await jiti.import("./http-dispatcher.ts");
  const { getGlobalDispatcher } = await import("undici");

  assert.throws(() => installHttpDispatcher({ timeoutMs: -1 }), /Invalid HTTP idle timeout/);
  installHttpDispatcher({ timeoutMs: 2_000 });
  // The network-proxy layer swaps in undici's own fetch while a proxy is configured: Next's
  // patched fetch wraps NODE's built-in fetch, whose dispatcher is a different copy, so the
  // global dispatcher alone reaches nothing (see applyGlobalFetchForProxy).
  applyGlobalFetchForProxy(true);

  const dispatcher = getGlobalDispatcher();
  installHttpDispatcher({ timeoutMs: 5_000 });
  assert.equal(getGlobalDispatcher(), dispatcher, "configuration should be idempotent");

  const httpResponse = await fetch("http://target.invalid/through-http-proxy", {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(httpResponse.status, 204);
  assert.deepEqual(forwardedRequests, ["GET http://target.invalid/through-http-proxy"]);
  assert.deepEqual(connectTargets, []);

  await assert.rejects(fetch("https://target.invalid/through-https-proxy", {
    signal: AbortSignal.timeout(2_000),
  }));
  assert.deepEqual(connectTargets, ["target.invalid:443"]);

  const forwardedRequestCount = forwardedRequests.length;
  const connectTargetCount = connectTargets.length;
  await assert.rejects(fetch("http://bypass.invalid:9/no-proxy", {
    signal: AbortSignal.timeout(2_000),
  }));
  assert.equal(forwardedRequests.length, forwardedRequestCount);
  assert.equal(connectTargets.length, connectTargetCount);
});

test("force re-installs the dispatcher so a proxy change takes effect without a restart", async (t) => {
  // EnvHttpProxyAgent reads HTTP_PROXY / HTTPS_PROXY in its constructor, so the network
  // proxy setting (lib/network-proxy.ts) needs a NEW instance — `configureHttpDispatcher`
  // staying idempotent is exactly why `installHttpDispatcher({ force: true })` exists.
  const originalEnv = new Map(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  t.after(() => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const forwarded = [];
  const proxy = createServer((req, res) => {
    forwarded.push(`${req.method} ${req.url}`);
    res.writeHead(204, { Connection: "close" });
    res.end();
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(async () => {
    await new Promise((resolve) => proxy.close(resolve));
  });
  const address = proxy.address();
  assert.ok(address && typeof address === "object");

  const jiti = createJiti(import.meta.url);
  const { installHttpDispatcher, applyGlobalFetchForProxy } = await jiti.import("./http-dispatcher.ts");
  const { getGlobalDispatcher } = await import("undici");

  installHttpDispatcher({ timeoutMs: 2_000, force: true });
  // Earlier tests may have left the proxy fetch installed (it is a process-wide global),
  // so reset first and take that as the baseline.
  applyGlobalFetchForProxy(false);
  const originalFetch = globalThis.fetch;
  assert.equal(globalThis.fetch, originalFetch, "reset must be a no-op when nothing was installed");
  applyGlobalFetchForProxy(true);
  assert.notEqual(globalThis.fetch, originalFetch, "a configured proxy must swap in undici's fetch");
  const direct = getGlobalDispatcher();
  await assert.rejects(fetch("http://target.invalid/before", { signal: AbortSignal.timeout(2_000) }));
  assert.deepEqual(forwarded, []);

  process.env.HTTP_PROXY = `http://127.0.0.1:${address.port}`;
  process.env.HTTPS_PROXY = process.env.HTTP_PROXY;
  installHttpDispatcher({ timeoutMs: 2_000, force: true });
  assert.notEqual(getGlobalDispatcher(), direct, "a forced install must replace the dispatcher");

  const response = await fetch("http://target.invalid/after", { signal: AbortSignal.timeout(3_000) });
  assert.equal(response.status, 204);
  assert.deepEqual(forwarded, ["GET http://target.invalid/after"]);
});
