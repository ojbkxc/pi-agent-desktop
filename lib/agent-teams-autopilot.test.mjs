import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  AUTOPILOT_SESSION_MARKERS,
  isAutopilotOriginatedSession,
  shouldAutoApprove,
  autoApproveTeamPlanForSession,
} = await jiti.import("./agent-teams-autopilot.ts");

const settings = (over = {}) => ({
  enabled: false,
  autoApproveTeamPlans: true,
  autoFixFailedRuns: true,
  maxAutoFixRounds: 12,
  ...over,
});

test("只有 scheduled / autofix 发起的会话算无人值守会话", () => {
  assert.equal(isAutopilotOriginatedSession(["pi-web:scheduled-run"]), true);
  assert.equal(isAutopilotOriginatedSession(["pi-web:subagent", "pi-web:autofix"]), true);
  assert.equal(isAutopilotOriginatedSession(["pi-web:subagent"]), false);
  assert.equal(isAutopilotOriginatedSession([]), false);
  for (const marker of AUTOPILOT_SESSION_MARKERS) {
    assert.equal(isAutopilotOriginatedSession([marker]), true, marker);
  }
});

test("shouldAutoApprove：总开关、子开关、会话来源三者缺一不可", () => {
  const marker = ["pi-web:scheduled-run"];
  assert.equal(shouldAutoApprove(settings(), marker), false, "总开关默认关");
  assert.equal(shouldAutoApprove(settings({ enabled: true, autoApproveTeamPlans: false }), marker), false);
  assert.equal(shouldAutoApprove(settings({ enabled: true }), []), false, "手动会话不自动批准");
  assert.equal(shouldAutoApprove(settings({ enabled: true }), marker), true);
});

// ── 端到端：review_pending 计划 + 临时 PI_TEAM_DIR 夹具 + 注入投递 ─────────────
// 存储侧（findTeamBySession / readTeamPlanView / resolveTeamLeadSession）都读
// PI_TEAM_DIR（见 agent-teams-swimlane-store.ts）；投递侧用注入的 deliver 拦住真
// RPC，从而把「判定 → 投递」整条链放进进程内测试，不写任何生产语义。
function teamFixture(t, { planState = "review_pending", planId = "plan-1" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-teams-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prev = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  t.after(() => {
    if (prev === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = prev;
  });

  const teamDir = join(root, "demo");
  mkdirSync(teamDir, { recursive: true });
  // config.json：真实 leadSessionId（非占位值）→ findTeamBySession 直接命中，
  // resolveTeamLeadSession 也据此返回它。
  writeFileSync(join(teamDir, "config.json"), JSON.stringify({
    name: "demo", createdAt: 1, leadAgentId: "lead", leadSessionId: "lead-sess", members: [],
  }));
  writeFileSync(join(teamDir, "plan.json"), JSON.stringify({
    planId,
    sessionId: "plan-sess",
    teamName: "demo",
    incarnationId: "inc-1",
    revision: 1,
    state: planState,
    members: [],
    tasks: [],
    updatedAt: 1,
  }));

  const settingsDir = mkdtempSync(join(tmpdir(), "pi-web-autopilot-settings-"));
  t.after(() => rmSync(settingsDir, { recursive: true, force: true }));
  const settingsPath = join(settingsDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ autopilot: { enabled: true, autoApproveTeamPlans: true, autoFixFailedRuns: true, maxAutoFixRounds: 2 } }));
  return { settingsPath };
}

test("端到端：无人值守会话 + review_pending 计划 → 自动投递批准 prompt 给 lead", async (t) => {
  const { settingsPath } = teamFixture(t, { planId: "plan-e2e-ok" });
  const delivered = [];
  const result = await autoApproveTeamPlanForSession({
    sessionId: "lead-sess",
    customTypes: ["pi-web:scheduled-run"],
    settingsPath,
    deliver: async (to, message) => { delivered.push({ to, message }); return { ok: true }; },
  });
  assert.equal(result.approved, true);
  assert.equal(delivered.length, 1, "投递一次");
  assert.equal(delivered[0].to, "lead-sess", "投递到解析出的 lead 会话");
  assert.match(delivered[0].message, /planId=plan-e2e-ok/, "prompt 带计划身份");
  assert.match(delivered[0].message, /approve/, "prompt 指示 lead 用 team_plan 批准");
});

test("端到端幂等：同一 plan+revision 只投递一次", async (t) => {
  const { settingsPath } = teamFixture(t, { planId: "plan-e2e-idem" });
  const delivered = [];
  const deliver = async (to, message) => { delivered.push({ to, message }); return { ok: true }; };
  const first = await autoApproveTeamPlanForSession({ sessionId: "lead-sess", customTypes: ["pi-web:scheduled-run"], settingsPath, deliver });
  const second = await autoApproveTeamPlanForSession({ sessionId: "lead-sess", customTypes: ["pi-web:scheduled-run"], settingsPath, deliver });
  assert.equal(first.approved, true);
  assert.equal(second.approved, false);
  assert.equal(second.reason, "already-delivered");
  assert.equal(delivered.length, 1);
});

test("端到端：手动会话不自动批准（不投递）", async (t) => {
  const { settingsPath } = teamFixture(t, { planId: "plan-e2e-manual" });
  const delivered = [];
  const result = await autoApproveTeamPlanForSession({
    sessionId: "lead-sess",
    customTypes: ["message"], // 手动会话，无无人值守标记
    settingsPath,
    deliver: async (to, message) => { delivered.push({ to, message }); return { ok: true }; },
  });
  assert.equal(result.approved, false);
  assert.equal(result.reason, "disabled");
  assert.equal(delivered.length, 0, "手动会话必须走人工评审");
});

test("端到端：计划不在 review_pending 时不投递", async (t) => {
  const { settingsPath } = teamFixture(t, { planState: "running", planId: "plan-e2e-running" });
  const delivered = [];
  const result = await autoApproveTeamPlanForSession({
    sessionId: "lead-sess",
    customTypes: ["pi-web:autofix"],
    settingsPath,
    deliver: async (to, message) => { delivered.push({ to, message }); return { ok: true }; },
  });
  assert.equal(result.approved, false);
  assert.match(result.reason, /state running/);
  assert.equal(delivered.length, 0);
});

test("端到端：投递失败如实返回，不算批准", async (t) => {
  const { settingsPath } = teamFixture(t, { planId: "plan-e2e-fail" });
  const result = await autoApproveTeamPlanForSession({
    sessionId: "lead-sess",
    customTypes: ["pi-web:scheduled-run"],
    settingsPath,
    deliver: async () => ({ ok: false, reason: "lead 会话正在运行，跳过以免打断" }),
  });
  assert.equal(result.approved, false);
  assert.equal(result.reason, "lead 会话正在运行，跳过以免打断");
});
