import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The outbound idle timeout is what decides whether a model stream that goes
 * quiet is kept alive. A relay that buffers, or a reasoning model that thinks
 * for minutes, must not be dropped mid-response — that shows up at the provider
 * as "client disconnected before the response completed".
 *
 * Configuration is process-global and set once, so the behavioural test lives in
 * its own file (node --test runs each file in its own process).
 */

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

test("resolveHttpIdleTimeoutMs 读环境变量，未设/非法值回退到默认", async () => {
  const jiti = createJiti(import.meta.url);
  const { DEFAULT_HTTP_IDLE_TIMEOUT_MS, resolveHttpIdleTimeoutMs } =
    await jiti.import("./http-dispatcher.ts");

  assert.equal(resolveHttpIdleTimeoutMs(undefined), DEFAULT_HTTP_IDLE_TIMEOUT_MS);
  assert.equal(resolveHttpIdleTimeoutMs("   "), DEFAULT_HTTP_IDLE_TIMEOUT_MS);
  assert.equal(resolveHttpIdleTimeoutMs("disabled"), 0);
  assert.equal(resolveHttpIdleTimeoutMs("0"), 0);
  assert.equal(resolveHttpIdleTimeoutMs("45000"), 45_000);
  assert.equal(resolveHttpIdleTimeoutMs("nonsense"), DEFAULT_HTTP_IDLE_TIMEOUT_MS);

  // 10 分钟是选定的默认值：中转站缓冲、长思考这类静默通常在几十秒到几分钟，
  // 而该计时随每个数据块刷新，所以正常输出的流不会因为总时长被掐。
  assert.equal(
    DEFAULT_HTTP_IDLE_TIMEOUT_MS,
    10 * 60_000,
    `默认空闲超时应为 10 分钟，实际 ${DEFAULT_HTTP_IDLE_TIMEOUT_MS}`,
  );
});

test("空闲超时只掐真正静止的响应，不掐持续输出的流", async (t) => {
  // Generous ratios on purpose: the whole suite runs several test files in
  // parallel, so a starved event loop must not turn "keeps trickling" into a
  // stall. The idle timeout is 20x the tick interval.
  const IDLE_TIMEOUT_MS = 1_200;
  const TICK_MS = 60;
  const originalEnv = new Map(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];

  // Stays silent longer than the timeout after its first chunk.
  const stalled = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: first\n\n");
    setTimeout(() => res.end("data: done\n\n"), 4_000);
  });
  // Keeps trickling, so the *total* duration exceeds the timeout while no single
  // gap does: proof the timer is an idle timer, not a deadline.
  const trickling = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: first\n\n");
    const ticker = setInterval(() => res.write("data: tick\n\n"), TICK_MS);
    setTimeout(() => {
      clearInterval(ticker);
      res.end("data: done\n\n");
    }, 3_000);
  });

  stalled.listen(0, "127.0.0.1");
  trickling.listen(0, "127.0.0.1");
  t.after(async () => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all(
      [stalled, trickling].map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });
  await Promise.all([once(stalled, "listening"), once(trickling, "listening")]);

  const jiti = createJiti(import.meta.url);
  const { configureHttpDispatcher } = await jiti.import("./http-dispatcher.ts");
  configureHttpDispatcher(IDLE_TIMEOUT_MS);

  const readAll = async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    let text = "";
    for await (const chunk of response.body) text += new TextDecoder().decode(chunk);
    return text;
  };

  const startedAt = Date.now();
  await assert.rejects(
    readAll(stalled.address().port),
    (error) => error?.cause?.code === "UND_ERR_BODY_TIMEOUT",
    "静默超过空闲超时的响应体应被 undici 掐断（否则这次读取会正常读到 done）",
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 3_500, `应在静默期结束时失败，而不是等服务器收尾，实际 ${elapsed} ms`);

  const trickled = await readAll(trickling.address().port);
  assert.match(trickled, /data: done/, "持续输出的流即使总时长超过超时也不该被掐");
});
