import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const route = await jiti.import("./route.ts");
const { parseUnattendedConfigUpdate } = await jiti.import("@/lib/agent-teams-unattended-config.ts");
const store = await jiti.import("@/lib/agent-teams-unattended-store.ts");
const { DEFAULT_UNATTENDED_CONFIG } = await jiti.import("@/lib/agent-teams-unattended.ts");

/** 把兜底设置文件隔离到临时目录（PI_CODING_AGENT_DIR），绝不碰用户真实文件。 */
async function isolate(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-fallback-route-"));
  const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, disabled: process.env.PI_WEB_DISABLE_TEAMS_FALLBACK };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_WEB_DISABLE_TEAMS_FALLBACK;
  t.after(() => {
    if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
    if (previous.disabled === undefined) delete process.env.PI_WEB_DISABLE_TEAMS_FALLBACK;
    else process.env.PI_WEB_DISABLE_TEAMS_FALLBACK = previous.disabled;
  });
  return dir;
}

const url = "http://localhost/api/teams/fallback";
// Host 是 fetch 的受限头，但 Node 的 Request 允许显式设置——本仓其它 local-only 路由测试同样这么做。
const request = (method, body) => new Request(url, {
  method,
  headers: body === undefined
    ? { Host: "localhost" }
    : { Host: "localhost", "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const get = () => route.GET(request("GET"));
const put = (body) => route.PUT(request("PUT", body));
const post = (body) => route.POST(request("POST", body));

test("GET returns config, envDisabled and manualNeeds", async (t) => {
  await isolate(t);
  const response = await get();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.config, { ...DEFAULT_UNATTENDED_CONFIG });
  assert.equal(body.envDisabled, false);
  assert.deepEqual(body.manualNeeds, {});
});

test("GET reports envDisabled when PI_WEB_DISABLE_TEAMS_FALLBACK=1", async (t) => {
  await isolate(t);
  process.env.PI_WEB_DISABLE_TEAMS_FALLBACK = "1";
  const body = await (await get()).json();
  assert.equal(body.envDisabled, true, "被环境变量关掉时如实反映");
});

test("PUT merges config and never touches the ledger", async (t) => {
  const dir = await isolate(t);
  const path = join(dir, "pi-web", "teams-fallback.json");
  store.writeUnattendedFile({
    config: { enabled: true, approvalTimeoutMs: 600000, maxFailureRetries: 2 },
    state: {
      approvalNudges: { p1: 1 },
      failureNudges: {},
      manualNeeds: { "plan:p1": { at: 5, reason: "投递失败" } },
    },
  }, path);

  const response = await put({ enabled: false, approvalTimeoutMs: 120000, maxFailureRetries: 0 });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.config, { enabled: false, approvalTimeoutMs: 120000, maxFailureRetries: 0 });

  const onDisk = store.readUnattendedFile(path);
  assert.deepEqual(onDisk.state.approvalNudges, { p1: 1 }, "PUT 不得改写 state");
  assert.deepEqual(onDisk.state.manualNeeds, { "plan:p1": { at: 5, reason: "投递失败" } });
});

test("PUT rejects out-of-range values", async (t) => {
  await isolate(t);
  assert.equal((await put({ approvalTimeoutMs: 30_000 })).status, 400, "低于 1 分钟下限");
  assert.equal((await put({ approvalTimeoutMs: 25 * 60 * 60_000 })).status, 400, "超过 24 小时上限");
  assert.equal((await put({ maxFailureRetries: 6 })).status, 400, "重试上限越界");
  assert.equal((await put({ maxFailureRetries: -1 })).status, 400);
  assert.equal((await put({ maxFailureRetries: 1.5 })).status, 400, "必须整数");
  assert.equal((await put({ enabled: "yes" })).status, 400);
  // 越界请求不得改动磁盘
  const onDisk = store.readUnattendedFile();
  assert.deepEqual(onDisk.config, { ...DEFAULT_UNATTENDED_CONFIG });
});

test("POST clear-manual-needs removes only the named key", async (t) => {
  const dir = await isolate(t);
  const path = join(dir, "pi-web", "teams-fallback.json");
  store.writeUnattendedFile({
    config: { enabled: true, approvalTimeoutMs: 600000, maxFailureRetries: 2 },
    state: {
      approvalNudges: { p1: 1 },
      failureNudges: { t1: { attempts: 1, lastAssignmentId: "a1", exhaustedNotified: false } },
      manualNeeds: {
        "plan:p1": { at: 5, reason: "投递失败" },
        "ticket:t9": { at: 6, reason: "已达重试上限" },
      },
    },
  }, path);

  const response = await post({ action: "clear-manual-needs", keys: ["plan:p1"] });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body.manualNeeds), ["ticket:t9"]);

  const onDisk = store.readUnattendedFile(path);
  assert.deepEqual(onDisk.config, { enabled: true, approvalTimeoutMs: 600000, maxFailureRetries: 2 }, "不得碰 config");
  assert.deepEqual(onDisk.state.approvalNudges, { p1: 1 }, "不得碰 approvalNudges");
  assert.deepEqual(Object.keys(onDisk.state.failureNudges), ["t1"], "不得碰 failureNudges");
});

test("POST rejects a bad action or empty keys", async (t) => {
  await isolate(t);
  assert.equal((await post({ action: "nope", keys: ["a"] })).status, 400);
  assert.equal((await post({ action: "clear-manual-needs", keys: [] })).status, 400);
  assert.equal((await post({ action: "clear-manual-needs", keys: [1] })).status, 400);
});

test("parseUnattendedConfigUpdate keeps unspecified fields and validates ranges", () => {
  const current = { enabled: true, approvalTimeoutMs: 600000, maxFailureRetries: 2 };
  assert.deepEqual(parseUnattendedConfigUpdate({ enabled: false }, current), {
    ok: true,
    config: { enabled: false, approvalTimeoutMs: 600000, maxFailureRetries: 2 },
  });
  assert.equal(parseUnattendedConfigUpdate({ approvalTimeoutMs: 59_999 }, current).ok, false);
  assert.equal(parseUnattendedConfigUpdate({ maxFailureRetries: 5 }, current).ok, true);
  assert.equal(parseUnattendedConfigUpdate({ maxFailureRetries: 6 }, current).ok, false);
  assert.equal(parseUnattendedConfigUpdate(null, current).ok, false);
});
