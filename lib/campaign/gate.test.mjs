import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Campaign 创建闸与运行时硬顶。
 *
 * git / 审批档走注入，三秒内锁死四种拒绝；另有一条真 git 的探测用例
 * （无 git 时自动跳过），确认真实现的判定口径。
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const gate = await jiti.import("./gate.ts");
const types = await jiti.import("./types.ts");

const validInput = () => ({
  objective: "把项目推进到可发布",
  cwd: "/tmp/project",
  maxTotalCostUsd: 5,
  items: [
    { title: "a", instruction: "do a", verifyCommand: "npm test" },
    { title: "b", instruction: "do b", verifyCommand: "npm test", dependsOn: ["item-1"] },
  ],
});

const withGate = (over = {}, options = {}) => gate.campaignCreateErrors(
  { ...validInput(), ...over },
  { isGitRepo: () => true, readApproval: () => "dangerous", ...options },
);

test("campaignCreateErrors：合法输入 + git + dangerous → 零错误", () => {
  assert.deepEqual(withGate(), []);
  // all 比 dangerous 更严，也放行。
  assert.deepEqual(withGate({}, { readApproval: () => "all" }), []);
});

test("campaignCreateErrors：拒绝无成本闸", () => {
  for (const value of [0, -3, Number.NaN]) {
    assert.ok(withGate({ maxTotalCostUsd: value }).includes("maxTotalCostUsdRequired"));
  }
});

test("campaignCreateErrors：拒绝非 git 目录", () => {
  const errors = withGate({}, { isGitRepo: () => false });
  assert.deepEqual(errors, ["cwdNotGit"]);
});

test("campaignCreateErrors：拒绝审批档 off（安全闸）", () => {
  assert.ok(withGate({}, { readApproval: () => "off" }).includes("approvalModeTooLow"));
  // 设置读取抛错按 off 处理，同样拒绝。
  assert.ok(withGate({}, { readApproval: () => { throw new Error("boom"); } }).includes("approvalModeTooLow"));
});

test("campaignCreateErrors：maxItems / maxTotalRounds 越界", () => {
  assert.ok(withGate({ maxItems: 0 }).includes("maxItemsRange"));
  assert.ok(withGate({ maxItems: 100000 }).includes("maxItemsRange"));
  assert.ok(withGate({ maxTotalRounds: 0 }).includes("maxTotalRoundsRange"));
  assert.ok(withGate({ maxTotalRounds: 100000 }).includes("maxTotalRoundsRange"));
});

test("campaignCreateErrors：形状错误会与原闸错误合并去重", () => {
  const errors = withGate({ objective: "", maxTotalCostUsd: 0 }, { isGitRepo: () => false, readApproval: () => "off" });
  for (const code of ["objectiveRequired", "maxTotalCostUsdRequired", "cwdNotGit", "approvalModeTooLow"]) {
    assert.ok(errors.includes(code), `missing ${code}`);
  }
  assert.equal(new Set(errors).size, errors.length, "errors must be unique");
});

test("approvalModeAtLeast：off < dangerous < all", () => {
  assert.equal(gate.approvalModeAtLeast("off", "dangerous"), false);
  assert.equal(gate.approvalModeAtLeast("dangerous", "dangerous"), true);
  assert.equal(gate.approvalModeAtLeast("all", "dangerous"), true);
  assert.equal(gate.CAMPAIGN_MIN_APPROVAL_MODE, "dangerous");
});

test("isGitRepo：非仓 false，git init 后 true", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-campaign-git-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal(gate.isGitRepo(dir), false, "empty temp dir is not a repo");
  assert.equal(gate.isGitRepo(""), false);

  let gitAvailable = true;
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    gitAvailable = false;
  }
  if (!gitAvailable) {
    t.skip("git not installed");
    return;
  }
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  assert.equal(gate.isGitRepo(dir), true);
});

test("itemRoundExceeded / campaignRuntimeStop：单项触顶优先于无闸", () => {
  const item = (over = {}) => ({
    id: "item-1",
    title: "t",
    instruction: "i",
    acceptance: "",
    verifyCommand: "true",
    dependsOn: [],
    status: "pending",
    round: 0,
    maxRounds: 20,
    costUsd: 0,
    lastError: null,
    rounds: [],
    ...over,
  });
  const campaign = (over = {}) => ({
    version: 1,
    id: "11111111-1111-4111-8111-111111111111",
    objective: "o",
    cwd: "/p",
    status: "running",
    items: [],
    currentItemId: null,
    maxTotalRounds: 400,
    maxItems: 40,
    maxTotalCostUsd: 10,
    spentCostUsd: 0,
    totalRounds: 0,
    intervalMs: 0,
    sessionId: null,
    pid: null,
    startedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    finishedAt: null,
    lastError: null,
    ...over,
  });

  assert.equal(gate.itemRoundExceeded(item({ round: 20, maxRounds: 20 })), true);
  assert.equal(gate.itemRoundExceeded(item({ round: 19, maxRounds: 20 })), false);

  assert.equal(gate.campaignRuntimeStop(campaign({ items: [item()] })), null);
  assert.equal(gate.campaignRuntimeStop(campaign({ items: [item({ round: 20 })] })), "itemMaxRounds");
  // 已 done 的项不参与单项触顶判定。
  assert.equal(gate.campaignRuntimeStop(campaign({ items: [item({ status: "done", round: 20 })] })), null);
  // 战役级闸优先。
  assert.equal(
    gate.campaignRuntimeStop(campaign({ items: [item({ round: 20 })], totalRounds: 400 })),
    "maxTotalRounds",
  );
});

test("gate 重新导出 types 的形状校验与硬闸", () => {
  assert.equal(typeof gate.campaignInputShapeErrors, "function");
  assert.equal(typeof gate.campaignGateExceeded, "function");
  assert.deepEqual(gate.campaignInputShapeErrors(validInput()), []);
  assert.equal(types.campaignGateExceeded, gate.campaignGateExceeded);
});
