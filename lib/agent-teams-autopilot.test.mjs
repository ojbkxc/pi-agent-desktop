import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  AUTOPILOT_SESSION_MARKERS,
  isAutopilotOriginatedSession,
  shouldAutoApprove,
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
