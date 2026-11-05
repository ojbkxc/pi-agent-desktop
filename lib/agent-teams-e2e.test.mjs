/**
 * 团队功能端到端链路测试（设计文档 Phase 5 缺失的那块）。
 *
 * 现有测试各自覆盖一层：`agent-teams-swimlane.test.mjs` 测投影、`app/api/teams/workbench-routes`
 * 测路由、`pi-extension-builtins.integration` 测扩展能被加载 —— 但没有一个测试把两侧接起来，
 * 证明「pi-team 工具写下的东西，desktop 侧真的能投影成泳道」。那个接缝（`~/.pi/agent/teams/<team>/`
 * 的 config/plan/mailbox 布局）正是最容易漂的地方：任一侧改了目录结构或字段名，单侧测试都还是绿的。
 *
 * 这里让真实的 pi-team 工具去写磁盘，再用 desktop 的 readTeamWorkbench 读回来。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// 必须在加载 pi-team 之前把团队目录指到临时目录。
const teamsDir = await mkdtemp(join(tmpdir(), "pi-web-teams-e2e-"));
process.env.PI_TEAM_DIR = teamsDir;
process.env.PI_TEAM_IDLE_TTL_MS = "0"; // 不在本测试里观察 parked
process.env.PI_TEAM_DEBUG = "0";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { readTeamWorkbench } = await jiti.import("./agent-teams-swimlane-store.ts");

// pi-team 是 sibling 仓的构建产物；没装就跳过，而不是让整个文件红掉。
let teamModule = null;
try {
  teamModule = await import("pi-team");
} catch {
  teamModule = null;
}

test.after(() => rm(teamsDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

/** 最小宿主桩：只记录调用，不真的起会话。 */
function makeHost() {
  const started = [];
  return {
    started,
    kind: "stub",
    async start(request) {
      started.push(request);
      return { sessionId: `sess-${request.name}`, sessionFile: `/tmp/${request.name}.jsonl`, status: "running" };
    },
    async revive() { return null; },
    async get() { return null; },
    async steer() {},
    async stop() {},
    async wake() { return true; },
    onFinish() { return () => {}; },
  };
}

/** 把 pi-team 扩展跑起来，拿到它注册的工具表。 */
function loadTeamTools(host) {
  const tools = new Map();
  const commands = new Map();
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, options) { commands.set(name, { name, ...options }); },
    on() { return () => {}; },
    appendEntry() {},
    getAllTools() {
      return [...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        sourceInfo: { path: "<e2e>", source: "extension" },
      }));
    },
  };
  const extension = teamModule.default;
  extension(pi);
  if (typeof teamModule.setInjectedHost === "function") teamModule.setInjectedHost(host);
  return { tools, commands };
}

const callTool = (tools, name, params) =>
  tools.get(name).execute(`call-${name}`, params, undefined, undefined, { cwd: process.cwd() });

const textOf = (result) => {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result.content)) {
    return result.content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("\n");
  }
  return JSON.stringify(result);
};

test("pi-team 写下的团队，desktop 侧能投影成泳道", { skip: !teamModule && "pi-team 未安装" }, async () => {
  const host = makeHost();
  const { tools } = loadTeamTools(host);

  const created = await callTool(tools, "team_create", {
    team_name: "e2e-team",
    description: "端到端链路",
    spawn: false, // 不真起会话：本测试只验证接缝，不验证 spawn
    members: [
      { name: "alice", prompt: "做 A" },
      { name: "bob", prompt: "做 B" },
    ],
  });
  assert.doesNotMatch(textOf(created), /失败|错误|LIMIT_EXCEEDED/, textOf(created));

  await callTool(tools, "team_message", {
    team_name: "e2e-team",
    recipient: "alice",
    message: "请先做 A 的第一部分",
    summary: "分派 A",
  });

  const snapshot = await readTeamWorkbench("e2e-team");
  assert.ok(snapshot, "desktop 侧必须能读到 pi-team 写的团队目录");

  // 1) 名册：lead 恒在，成员顺序与创建时一致。
  const names = snapshot.members.map((member) => member.name);
  assert.deepEqual(names, ["team-lead", "alice", "bob"]);

  // 2) 泳道：每个成员一条 lane。
  assert.equal(snapshot.lanes.length, 3, `期望 3 条 lane，实际 ${snapshot.lanes.length}`);
  assert.deepEqual(snapshot.lanes.map((lane) => lane.name).sort(), ["alice", "bob", "team-lead"]);

  // 3) 消息变成了跨 lane 的 flow：team-lead -> alice。
  const flow = snapshot.flows.find((item) => item.from === "team-lead" && item.to === "alice");
  assert.ok(flow, `期望 team-lead→alice 的 flow，实际 ${JSON.stringify(snapshot.flows)}`);

  // 4) 消息正文进到了**发起方**（team-lead）的 lane 事件里 —— 事件归发起方 lane，
  //    收件方只通过 flows 的箭头看到它（设计文档 §7.1）。
  const leadLane = snapshot.lanes.find((lane) => lane.name === "team-lead");
  const joined = JSON.stringify(leadLane);
  assert.match(joined, /请先做 A 的第一部分/, "消息正文应出现在发起方的 lane 事件里");
  const messageEvent = leadLane.events.find((event) => event.type === "message");
  assert.ok(messageEvent, `team-lead 的 lane 应有 message 事件，实际 ${JSON.stringify(leadLane.events)}`);
  assert.equal(messageEvent.from, "team-lead");
  assert.equal(messageEvent.to, "alice");
});

test("pi-team 删除团队后，desktop 侧投影返回 null", { skip: !teamModule && "pi-team 未安装" }, async () => {
  const host = makeHost();
  const { tools } = loadTeamTools(host);

  await callTool(tools, "team_create", {
    team_name: "gone-team",
    spawn: false,
    members: [{ name: "carol", prompt: "做 C" }],
  });
  assert.ok(await readTeamWorkbench("gone-team"), "删除前应能投影");

  await callTool(tools, "team_delete", { team_name: "gone-team" });
  assert.equal(await readTeamWorkbench("gone-team"), null, "删除后 desktop 侧应返回 null 而不是抛错");
});
