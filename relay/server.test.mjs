import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest, { after } from "node:test";
import { WebSocket } from "ws";
import { KIND, agentIdFor, createRelay } from "./server.mjs";

/**
 * 每个用例都有硬上限。
 *
 * 这些用例靠「等一条 websocket 消息」推进，而 `node --test` 默认没有超时：
 * 一旦哪个 socket 在并发负载下没按预期回话，整个测试进程就永久挂住——实测在
 * `--test-concurrency=4` 的全量跑里挂了 941 秒，只有手动 kill 才结束（CI 上就是
 * 整个 job 卡死）。超时后失败会指出是哪一条用例，比无限等待有用得多。
 */
const TEST_TIMEOUT_MS = 20_000;
const test = (name, fn) => nodeTest(name, { timeout: TEST_TIMEOUT_MS }, fn);

const subtle = globalThis.crypto.subtle;
const ADMIN = "admin-token-for-tests";

/**
 * 每个 `startRelay()` 建一个临时数据目录。以前只有 `relay.close()` 进了 `t.after`，
 * 目录本身没人删：全量跑一轮就往 `%TEMP%` 落十几个 `pi-relay-test-*`，实测本机
 * 攒了 42 个。这里统一收集、文件级 `after` 一次清掉（Windows 上刚关的 ws 句柄可能
 * 还占着文件，失败重试即可）。
 */
const createdDirs = [];
after(() => {
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // 临时目录，留给系统清理。
    }
  }
});

async function startRelay(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-relay-test-"));
  createdDirs.push(dir);
  const relay = createRelay({ adminToken: ADMIN, dataFile: join(dir, "agents.json"), ...extra });
  const port = await relay.listen(0, "127.0.0.1");
  return { relay, port, dir, url: `ws://127.0.0.1:${port}` };
}

function waitFor(ws, event) {
  return new Promise((resolve) => ws.once(event, (...args) => resolve(args)));
}

function nextMessage(ws) {
  return new Promise((resolve) => ws.once("message", (data, isBinary) => resolve({ data, isBinary })));
}

/**
 * 给「等一个可能永远不来的事件」加上标签与上限。
 *
 * `node --test` 默认没有超时，`waitFor()` 等不到事件就永远不返回——全量并发跑里
 * 这一条曾挂 941 秒。带上标签后，卡住的那一步会以「timed out waiting for X」失败。
 */
function withLabel(promise, label, timeoutMs = 15_000) {
  const timer = new Promise((_, reject) => {
    const handle = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    handle.unref?.();
  });
  return Promise.race([promise, timer]);
}

/** 轮询到条件成立（有上限）。由调用方用 `withLabel` 包一个可读的失败原因。 */
async function waitUntil(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

/**
 * 发一帧数据、等桌面把它回显出来，等到为止（有上限）。
 *
 * `auth` 帧走桌面 socket，数据帧走手机 socket：两个 socket 之间**没有**先后保证。
 * 原先的注释假设「auth 一定先处理完」，负载一高就可能反过来，于是 owner 还被当作
 * 陌生人、数据帧被丢，测试在等一条永远不会来的回显。这里改成重发 + 有界等待：
 * 认证一旦生效，下一帧必然被转发；真不生效则 5 秒后带着原因失败。
 */
async function echoThrough(phone, echoes, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const startedAt = echoes.length;
    phone.send(Buffer.from(text));
    while (Date.now() < deadline) {
      if (echoes.length > startedAt) return echoes[echoes.length - 1];
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (echoes.length > startedAt) return echoes[echoes.length - 1];
    }
    if (Date.now() >= deadline) throw new Error(`the desktop never echoed "${text}"`);
  }
}

async function agentKeys() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = Buffer.from(await subtle.exportKey("spki", pair.publicKey));
  return { pair, spki, id: agentIdFor(spki) };
}

async function connectAgent(url, keys, { admin = ADMIN, signWith = keys } = {}) {
  const ws = new WebSocket(`${url}/agent`);
  const [challenge] = await waitFor(ws, "message");
  const { nonce } = JSON.parse(String(challenge));
  const sig = Buffer.from(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signWith.pair.privateKey,
    new TextEncoder().encode(`pi-relay-agent/1\n${nonce}`)));
  ws.send(JSON.stringify({ t: "hello", key: keys.spki.toString("base64url"), sig: sig.toString("base64url"), ...(admin ? { admin } : {}) }));
  const outcome = await Promise.race([
    nextMessage(ws).then(({ data }) => ({ ready: JSON.parse(String(data)) })),
    waitFor(ws, "close").then(([code, reason]) => ({ closed: code, reason: String(reason) })),
  ]);
  return { ws, ...outcome };
}

function connectClient(url, agentId) {
  const ws = new WebSocket(`${url}/client?agent=${encodeURIComponent(agentId)}`);
  // Captured now: the event can fire while the test is awaiting something else.
  ws.opened = waitFor(ws, "open");
  return ws;
}

test("health check", async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());
  const body = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
  assert.deepEqual(body, { ok: true, agentsOnline: 0 });
});

test("a new desktop registers only with the admin token, then reconnects without it", async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());
  const keys = await agentKeys();

  const refused = await connectAgent(url, keys, { admin: "" });
  assert.equal(refused.closed, 4401);
  assert.match(refused.reason, /admin token/);
  const wrong = await connectAgent(url, keys, { admin: "guess" });
  assert.equal(wrong.closed, 4401);

  const first = await connectAgent(url, keys);
  assert.deepEqual(first.ready, { t: "ready", agentId: keys.id });
  first.ws.close();
  await waitFor(first.ws, "close");

  const again = await connectAgent(url, keys, { admin: "" });
  assert.equal(again.ready?.agentId, keys.id);
  again.ws.close();
});

test("a relay without an admin token registers nobody", async (t) => {
  const { relay, url } = await startRelay({ adminToken: "" });
  t.after(() => relay.close());
  const outcome = await connectAgent(url, await agentKeys(), { admin: "" });
  assert.equal(outcome.closed, 4401);
});

test("a signature by another key is refused", async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());
  const keys = await agentKeys();
  const outcome = await connectAgent(url, keys, { signWith: await agentKeys() });
  assert.equal(outcome.closed, 4401);
  assert.match(outcome.reason, /bad signature/);
});

test("phones reach only their own desktop, both ways, with open and close", async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());
  const a = await connectAgent(url, await agentKeys());
  const bKeys = await agentKeys();
  const b = await connectAgent(url, bKeys);

  const bMessages = [];
  b.ws.on("message", (d) => bMessages.push(d));

  const phone = connectClient(url, a.ready.agentId);
  const open = await nextMessage(a.ws);
  assert.equal(open.data[0], KIND.open);
  const clientId = open.data.subarray(1, 17);
  await phone.opened;

  phone.send(Buffer.from("ciphertext-1"));
  const data = await nextMessage(a.ws);
  assert.equal(data.data[0], KIND.data);
  assert.deepEqual(data.data.subarray(1, 17), clientId);
  assert.equal(String(data.data.subarray(17)), "ciphertext-1");

  const reply = Buffer.concat([Buffer.of(KIND.data), clientId, Buffer.from("ciphertext-2")]);
  a.ws.send(reply);
  const got = await nextMessage(phone);
  assert.equal(String(got.data), "ciphertext-2");
  assert.equal(bMessages.length, 0, "the other desktop saw nothing");

  phone.close();
  const closed = await nextMessage(a.ws);
  assert.equal(closed.data[0], KIND.close);
  assert.deepEqual(closed.data.subarray(1, 17), clientId);
  a.ws.close();
  b.ws.close();
});

test("a desktop cannot write to another desktop's phone", async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());
  const a = await connectAgent(url, await agentKeys());
  const b = await connectAgent(url, await agentKeys());
  const phone = connectClient(url, a.ready.agentId);
  const open = await nextMessage(a.ws);
  await phone.opened;
  const received = [];
  phone.on("message", (d) => received.push(String(d)));
  b.ws.send(Buffer.concat([Buffer.of(KIND.data), open.data.subarray(1, 17), Buffer.from("forged")]));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(received, []);
  a.ws.close();
  b.ws.close();
});

test("the desktop can close a phone; a desktop going away closes its phones", async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());
  const a = await connectAgent(url, await agentKeys());
  const p1 = connectClient(url, a.ready.agentId);
  const open1 = await nextMessage(a.ws);
  await p1.opened;
  a.ws.send(Buffer.concat([Buffer.of(KIND.close), open1.data.subarray(1, 17)]));
  const [code1] = await waitFor(p1, "close");
  assert.equal(code1, 4000);

  const p2 = connectClient(url, a.ready.agentId);
  await nextMessage(a.ws);
  await p2.opened;
  a.ws.close();
  const [code2] = await waitFor(p2, "close");
  assert.equal(code2, 4502);
});

test("phones of an offline desktop and text frames are refused", async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());
  const [offline] = await waitFor(connectClient(url, "nobody"), "close");
  assert.equal(offline, 4404);
  const a = await connectAgent(url, await agentKeys());
  const p1 = connectClient(url, a.ready.agentId);
  await p1.opened;
  p1.send("plain text");
  const [textCode] = await waitFor(p1, "close");
  assert.equal(textCode, 4400);
  a.ws.close();
});

test("strangers cannot crowd out the owner: the oldest stranger makes room", async (t) => {
  const { relay, url } = await startRelay({ maxStrangersPerAgent: 2, maxClientsPerAgent: 1 });
  t.after(() => relay.close());
  const a = await connectAgent(url, await agentKeys());
  const opens = [];
  // B-7：原来用固定 50ms 睡眠后按索引取第 3 帧 open，负载高的 CI 上该帧可能没到，
  // 负载一高就随机红。改为等第 3 帧真的到达再发送，不依赖计时。
  let resolveThreeOpens = () => {};
  const threeOpens = new Promise((resolve) => { resolveThreeOpens = resolve; });
  const dataEchoes = [];
  a.ws.on("message", (d) => {
    if (d[0] === KIND.data) dataEchoes.push(String(d.subarray(17)));
    if (d[0] === KIND.open) {
      opens.push(d.subarray(1, 17));
      if (opens.length >= 3) resolveThreeOpens();
    }
  });
  const s1 = connectClient(url, a.ready.agentId);
  connectClient(url, a.ready.agentId);
  // 桌面看到两帧 `open` 才算这两个陌生人「已登记」。客户端侧的 `opened` 只是握手
  // 完成，relay 的 acceptClient 可能还没执行（并发负载下差几十毫秒），那会让后面
  // 「腾位置」的判定不触发，只能等到超时 —— 实测 1/6。
  await withLabel(waitUntil(() => opens.length >= 2), "the desktop to see the first two open frames");
  const s1Closed = waitFor(s1, "close");
  const owner = connectClient(url, a.ready.agentId);
  await owner.opened;
  assert.equal((await withLabel(s1Closed, "the oldest stranger to be closed"))[0], 4429,
    "the oldest stranger was dropped, the newcomer got in");
  // The desktop authenticates the owner; authenticated phones have their own cap.
  await withLabel(threeOpens, "the desktop to see three open frames");
  a.ws.send(Buffer.concat([Buffer.of(KIND.auth), opens[2]]));
  // 中继按到达顺序处理消息：auth 帧先于新客户端的 open 帧入队，无需固定睡眠等它处理。
  const second = connectClient(url, a.ready.agentId);
  await second.opened;
  // auth 与数据走的是**两条不同的 socket**（桌面 / 手机），跨 socket 没有顺序保证：
  // 原先「auth 先到」是假设，负载一高就可能反过来，owner 被当成陌生人、数据帧被丢，
  // 而这里在等一条永远不来的回显——整轮挂死（实测 941s）。改成有界重发 + 有界等待：
  // 语义仍是「认证过的 owner 不受新来者影响」，但不会再无限等。
  const got = await echoThrough(owner, dataEchoes, "still here", 5_000);
  assert.equal(got, "still here", "the authenticated owner is unaffected by newcomers");
  a.ws.close();
});

test("a stranger may send only so much before the desktop authenticates it", async (t) => {
  const { relay, url } = await startRelay({ strangerBytes: 1000 });
  t.after(() => relay.close());
  const a = await connectAgent(url, await agentKeys());
  const phone = connectClient(url, a.ready.agentId);
  await phone.opened;
  phone.send(Buffer.alloc(600));
  phone.send(Buffer.alloc(600));
  const [code] = await waitFor(phone, "close");
  assert.equal(code, 4013);
  a.ws.close();
});

test("the desktop says which closes mean 'not paired'", async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());
  const a = await connectAgent(url, await agentKeys());
  const phone = connectClient(url, a.ready.agentId);
  const open = await nextMessage(a.ws);
  await phone.opened;
  a.ws.send(Buffer.concat([Buffer.of(KIND.close), open.data.subarray(1, 17), Buffer.of(1)]));
  const [code] = await waitFor(phone, "close");
  assert.equal(code, 4001);
  a.ws.close();
});

test("a phone is closed rather than queued when its desktop is not reading", async (t) => {
  // Below zero, any queued byte counts as over the limit: the check runs on every message.
  const { relay, url } = await startRelay({ maxQueuedBytes: -1 });
  t.after(() => relay.close());
  const a = await connectAgent(url, await agentKeys());
  const phone = connectClient(url, a.ready.agentId);
  await phone.opened;
  phone.send(Buffer.from("x"));
  const [code] = await waitFor(phone, "close");
  assert.equal(code, 4008);
  a.ws.close();
});

test("a newer connection of the same desktop replaces the old one", async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());
  const keys = await agentKeys();
  const first = await connectAgent(url, keys);
  const second = await connectAgent(url, keys, { admin: "" });
  const [code] = await waitFor(first.ws, "close");
  assert.equal(code, 4409);
  const phone = connectClient(url, keys.id);
  const open = await nextMessage(second.ws);
  assert.equal(open.data[0], KIND.open);
  phone.close();
  second.ws.close();
});

test("connection attempts are rate limited per address", async (t) => {
  const { relay, url } = await startRelay({ connectionsPerMinute: 2 });
  t.after(() => relay.close());
  const results = [];
  for (let i = 0; i < 3; i++) {
    const ws = new WebSocket(`${url}/client?agent=x`);
    results.push(await Promise.race([
      waitFor(ws, "close").then(([code]) => `close ${code}`),
      waitFor(ws, "unexpected-response").then(([, res]) => `http ${res.statusCode}`),
      waitFor(ws, "error").then(() => "error"),
    ]));
  }
  assert.deepEqual(results.slice(0, 2), ["close 4404", "close 4404"]);
  assert.equal(results[2], "http 429");
});

test("oversized messages are refused", async (t) => {
  const { relay, url } = await startRelay({ maxMessageBytes: 1024 });
  t.after(() => relay.close());
  const a = await connectAgent(url, await agentKeys());
  const phone = connectClient(url, a.ready.agentId);
  await phone.opened;
  phone.send(Buffer.alloc(4096));
  const [code] = await waitFor(phone, "close");
  assert.equal(code, 1009);
  a.ws.close();
});

test("the optional shell is served without escaping its directory", async (t) => {
  const shellDir = mkdtempSync(join(tmpdir(), "pi-relay-shell-"));
  mkdirSync(join(shellDir, "__shell"));
  writeFileSync(join(shellDir, "__shell", "index.html"), "<p>shell</p>");
  writeFileSync(join(shellDir, "sw.js"), "// sw");
  const { relay, port } = await startRelay({ shellDir });
  t.after(async () => { await relay.close(); rmSync(shellDir, { recursive: true, force: true }); });
  const get = (path) => fetch(`http://127.0.0.1:${port}${path}`);
  assert.equal(await (await get("/__shell/")).text(), "<p>shell</p>");
  const sw = await get("/sw.js");
  assert.equal(sw.headers.get("service-worker-allowed"), "/");
  assert.equal((await get("/../../etc/passwd")).status, 404);
  assert.equal((await get("/%2e%2e/%2e%2e/etc/passwd")).status, 404);
});
