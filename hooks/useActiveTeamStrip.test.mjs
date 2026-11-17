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

// ── state.md P2：refreshKey（消息计数）不能把已显示的团队条清空再挂回 ─────────
// 无 DOM 渲染器，hook 的 effect 驱动不了；这里钉住接线形状：setSnapshot(null) 必须
// 在只依赖 sessionId 的独立 effect 里，主轮询 effect 的开头不得再无条件清空。
test("接线：setSnapshot(null) 只在 sessionId 变化时执行（refreshKey 只补拉，不清旧快照）", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(new URL("./useActiveTeamStrip.ts", import.meta.url), "utf8");
  const source = raw.replace(/\r\n/g, "\n");

  // 独立的清空 effect：依赖数组里只有 sessionId。
  const resetEffect = source.indexOf("useEffect(() => {\n    setSnapshot(null);\n  }, [sessionId]);");
  assert.ok(resetEffect > 0, "setSnapshot(null) 必须住在只依赖 sessionId 的 effect 里");
  // 主轮询 effect 的依赖仍是 sessionId + refreshKey（refreshKey 继续触发补拉）。
  assert.match(source, /\}, \[sessionId, refreshKey\]\);/);
  // 主 effect 开头不得再无条件清空（旧缺陷：每发一条消息条就闪一次）。
  const mainEffect = source.slice(source.indexOf("if (!sessionId) return;"));
  const head = mainEffect.slice(0, mainEffect.indexOf("let stopped"));
  assert.doesNotMatch(head, /setSnapshot\(null\)/, "主 effect 开头不得清空快照");
});
