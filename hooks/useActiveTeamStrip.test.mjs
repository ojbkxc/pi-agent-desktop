import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// 会话头部团队条（B1）纯逻辑单测：显示态派生、进度口径、活跃期判定。
// 组件渲染（头像堆叠 / 类名 / i18n 键）由 verifier 批次一覆盖；这里只钉可静态验证的派生。
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const {
  deriveTeamStripPhase,
  deriveTeamStripProgress,
  isActiveTeamPhase,
} = await jiti.import("./useActiveTeamStrip.ts");

/** 最小成员（投影层 member.status 不含 "failed"）。 */
function member(name, status = "idle") {
  return {
    id: name,
    name,
    role: "member",
    model: null,
    providerName: null,
    color: "blue",
    status,
    activity: "idle",
    sessionId: null,
    cwd: "",
    worktreePath: null,
    lastError: null,
    joinedAt: "",
  };
}

/** 最小票；outcome 非空时带一条 ended 派活（用于 failed 口径）。 */
function ticket(id, status, outcome) {
  return {
    id,
    subject: id,
    description: "",
    ownerId: null,
    status,
    dependencies: [],
    assignments: outcome
      ? [{
        id: `${id}-1`,
        status: "ended",
        memberId: null,
        assignee: "x",
        sessionId: null,
        startedAt: null,
        lastActivityAt: null,
        result: null,
        outcome,
      }]
      : [],
    source: "plan",
    createdAt: "",
  };
}

function snapshot({ members, tickets = [], status = "running" }) {
  return {
    version: 1,
    generatedAt: "",
    team: {
      id: "t",
      name: "t",
      description: "",
      createdAt: "",
      leadSessionId: null,
      status,
      incarnationId: "t",
    },
    members,
    tickets,
    lanes: [],
    flows: [],
    taskAnchors: [],
    tasks: [],
    receipts: [],
  };
}

test("无快照 / 空名册 → none（条不渲染、不占位）", () => {
  assert.equal(deriveTeamStripPhase(null), "none");
  assert.equal(deriveTeamStripPhase(snapshot({ members: [] })), "none");
});

test("团队阶段直通", () => {
  assert.equal(deriveTeamStripPhase(snapshot({ members: [member("lead", "running")], status: "running" })), "running");
  assert.equal(deriveTeamStripPhase(snapshot({ members: [member("lead")], status: "completed" })), "completed");
});

test("失败派活 → failed（红），优先于 interrupted", () => {
  const members = [member("lead"), member("w1", "aborted")];
  const tickets = [ticket("t1", "ended", "failed")];
  assert.equal(deriveTeamStripPhase(snapshot({ members, tickets })), "failed");
});

test("成员被中止 → interrupted（黄）", () => {
  const members = [member("lead"), member("w1", "aborted")];
  assert.equal(deriveTeamStripPhase(snapshot({ members })), "interrupted");
});

test("进度：completed 只认紧急度真源（失败票不计入完成）", () => {
  const tickets = [ticket("t1", "ended"), ticket("t2", "ended", "failed"), ticket("t3", "open")];
  assert.deepEqual(
    deriveTeamStripProgress(snapshot({ members: [member("lead")], tickets })),
    { completed: 1, total: 3 },
  );
  assert.deepEqual(deriveTeamStripProgress(null), { completed: 0, total: 0 });
});

test("isActiveTeamPhase 仅活跃期", () => {
  assert.equal(isActiveTeamPhase("forming"), true);
  assert.equal(isActiveTeamPhase("running"), true);
  assert.equal(isActiveTeamPhase("finishing"), true);
  assert.equal(isActiveTeamPhase("completed"), false);
  assert.equal(isActiveTeamPhase("ended"), false);
  assert.equal(isActiveTeamPhase(undefined), false);
});
