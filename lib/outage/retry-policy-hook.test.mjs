import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * 端到端：`all` 档让一个 **terminal** 错误（401 鉴权失败）也进入挂起等待，
 * 而不是像默认档那样直接按失败上报。
 *
 * 这是用户的需求本体——「失败的请求会持续重试，直到成功或本轮被停止」——
 * 落到 `onAgentRunSettled` 这一层：默认档 401 → `suspended: false`；
 * 该 provider 配了 `all` → `suspended: true`、记录落盘、由调度器续跑。
 *
 * Stop 语义仍然优先：`aborted: true` 一律不挂起（由 hook 的第一道判断挡掉）。
 */
const root = mkdtempSync(join(tmpdir(), "pi-web-retry-hook-"));
const agentDir = join(root, "agent");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const hook = await jiti.import("./rpc-hook.ts");
const store = await jiti.import("./retry-policy-store.ts");
const outageStore = await jiti.import("./store.ts");
const { getPiWebSettingsPath } = await jiti.import("../artifact-settings.ts");

after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

const settingsPath = getPiWebSettingsPath(agentDir);
const UNAUTHORIZED = "401 Unauthorized: invalid api key";

function settle(input) {
  return hook.onAgentRunSettled({
    outcome: { status: "failed", error: UNAUTHORIZED },
    scope: "chat",
    agentDir,
    now: Date.now(),
    sessionFile: null,
    cwd: root,
    lastUserMessageId: "u1",
    ...input,
  });
}

test("by default a 401 is terminal: reported, never suspended", async () => {
  const result = await settle({ sessionId: "s-default", model: { provider: "openai" } });
  assert.equal(result.suspended, false, "the default policy keeps today's behaviour");
  assert.ok(!outageStore.getOutageRecord("s-default", agentDir), "no record is written");
});

test("with `all` on that provider the same 401 is suspended and retried until success or Stop", async () => {
  store.setProviderModelRetryPolicy("openai", "all", settingsPath);
  const result = await settle({ sessionId: "s-all", model: { provider: "openai" } });
  assert.equal(result.suspended, true, "a terminal error becomes a suspendable outage");
  const record = outageStore.getOutageRecord("s-all", agentDir);
  assert.ok(record, "the record lands on disk so a restart can resume it");
  assert.equal(record.status, "waiting");
  // The budget is the record's own shape (`deadlineAt`/`maxAttempts`), not a maxWaitMs field.
  assert.ok(
    record.budget.deadlineAt - record.budget.startedAt >= 6 * 3_600_000,
    `\`all\` gets the wider wait budget; got ${record.budget.deadlineAt - record.budget.startedAt} ms`,
  );
  assert.ok(record.budget.maxAttempts > 40, "…and the higher attempt ceiling");
});

test("Stop still wins: an aborted run is never suspended, even under `all`", async () => {
  const result = await settle({ sessionId: "s-stop", model: { provider: "openai" }, aborted: true });
  assert.equal(result.suspended, false);
  assert.ok(!outageStore.getOutageRecord("s-stop", agentDir));
});

test("providers without their own entry keep the default behaviour", async () => {
  const result = await settle({ sessionId: "s-other", model: { provider: "some-other-api" } });
  assert.equal(result.suspended, false);
});

test("the wildcard entry covers every provider that has no explicit one", async () => {
  store.setProviderModelRetryPolicy("*", "all", settingsPath);
  const result = await settle({ sessionId: "s-wild", model: { provider: "brand-new-api" } });
  assert.equal(result.suspended, true);
});