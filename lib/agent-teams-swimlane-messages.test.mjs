import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * C6（团队通信流）对 lib/agent-teams-swimlane.ts 的追加式投影扩展断言：
 *   1) messages[]：邮箱消息 → 通信流消息（id 直通、kind、recipients、to）；
 *   2) protocolType / taskId：从结构化 text JSON 解析（p0-recon Q4 缺口补足）；
 *   3) isLead：成员队长标记（单一真源，供分类判定）。
 * 只断言新增字段，不动既有字段语义。
 */
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { projectTeamWorkbench } = await jiti.import("./agent-teams-swimlane.ts");

const JOINED = Date.parse("2026-11-05T00:00:00.000Z");

function baseInput() {
  return {
    teamName: "demo",
    generatedAt: "2026-11-05T03:00:00.000Z",
    team: {
      name: "demo",
      description: "",
      createdAt: JOINED,
      leadAgentId: "team-lead",
      leadSessionId: "lead-session",
      members: [
        { agentId: "lead-1", name: "team-lead", agentType: "orchestrator", joinedAt: JOINED, cwd: "" },
        { agentId: "w1", name: "w1", agentType: "general-purpose", joinedAt: JOINED, cwd: "" },
      ],
    },
    plan: null,
    lifecycle: {},
    messages: [],
    accepted: [],
  };
}

test("members：isLead 标记队长（config 首位/leadAgentId 命中），其余成员为 false", () => {
  const snapshot = projectTeamWorkbench(baseInput());
  assert.equal(snapshot.members[0].isLead, true, "team-lead 是队长");
  assert.equal(snapshot.members[1].isLead, false);
});

test("messages[]：保留 id、from/to/recipients、kind（direct），空邮箱 → 空数组", () => {
  const input = baseInput();
  input.messages = [
    { id: "m-1", from: "team-lead", to: "w1", text: "开始", summary: "开始", timestamp: "2026-11-05T01:00:00.000Z" },
  ];
  const snapshot = projectTeamWorkbench(input);
  assert.equal(snapshot.messages.length, 1);
  const [message] = snapshot.messages;
  assert.equal(message.id, "m-1", "id 直通（供回执对齐）");
  assert.equal(message.from, "team-lead");
  assert.equal(message.to, "w1");
  assert.deepEqual(message.recipients, ["w1"]);
  assert.equal(message.kind, "direct");
  assert.equal(message.text, "开始");
  assert.equal(message.summary, "开始");
  assert.equal(message.timestamp, "2026-11-05T01:00:00.000Z");

  // 无消息 → 空数组（既有 fixture 缺省即此路径）
  assert.deepEqual(projectTeamWorkbench(baseInput()).messages, []);
});

test("messages[]：结构化 JSON text → protocolType / taskId 直通，非 JSON 文本不携带", () => {
  const input = baseInput();
  input.messages = [
    {
      id: "m-assign",
      from: "team-lead",
      to: "w1",
      text: JSON.stringify({ type: "task_assignment", taskId: "T1", subject: "实现 X" }),
      timestamp: "2026-11-05T01:00:00.000Z",
    },
    {
      id: "m-idle",
      from: "w1",
      to: "team-lead",
      text: JSON.stringify({ type: "idle_notification", message: "等待派活" }),
      timestamp: "2026-11-05T01:01:00.000Z",
    },
    { id: "m-plain", from: "w1", to: "team-lead", text: "做完了", timestamp: "2026-11-05T01:02:00.000Z" },
  ];
  const snapshot = projectTeamWorkbench(input);
  const assign = snapshot.messages.find((m) => m.id === "m-assign");
  assert.equal(assign.protocolType, "task_assignment", "JSON 载荷的 type 直通为 protocolType");
  assert.equal(assign.taskId, "T1", "JSON 载荷的 taskId 直通");
  const idle = snapshot.messages.find((m) => m.id === "m-idle");
  assert.equal(idle.protocolType, "idle_notification");
  assert.equal("taskId" in idle, false, "无 taskId 时不编造");
  const plain = snapshot.messages.find((m) => m.id === "m-plain");
  assert.equal("protocolType" in plain, false, "非 JSON 文本不携带 protocolType");
  assert.equal(plain.text, "做完了");
});

test("messages[]：缺 id 时用稳定身份（from|timestamp|text），to=\"*\" 视为广播", () => {
  const input = baseInput();
  input.messages = [
    { from: "team-lead", to: "*", text: "全体注意", timestamp: "2026-11-05T01:00:00.000Z" },
  ];
  const snapshot = projectTeamWorkbench(input);
  const [message] = snapshot.messages;
  assert.equal(message.kind, "broadcast");
  assert.equal(message.id, "mail:team-lead|2026-11-05T01:00:00.000Z|全体注意");
  assert.deepEqual(message.recipients, ["*"]);
});

test("messages[]：message.color 直通；无 from 记为 system", () => {
  const input = baseInput();
  input.messages = [
    { id: "m-sys", from: "", to: "", text: "系统通知", color: "red", timestamp: "2026-11-05T01:00:00.000Z" },
  ];
  const [message] = projectTeamWorkbench(input).messages;
  assert.equal(message.kind, "system");
  assert.equal(message.color, "red");
  assert.deepEqual(message.recipients, []);
});

test("既有字段不受影响：messages 输入缺省时其余投影与显式空数组一致", () => {
  const withField = projectTeamWorkbench({ ...baseInput(), messages: [] });
  const without = projectTeamWorkbench({ ...baseInput() });
  assert.deepEqual(withField.tickets, without.tickets);
  assert.deepEqual(withField.lanes, without.lanes);
  assert.deepEqual(withField.tasks, without.tasks);
  assert.deepEqual(withField.messages, []);
});
