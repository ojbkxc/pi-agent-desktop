import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

// 内置接线集成测试：走真实 SDK ResourceLoader，确认
//   - `builtin:pi-lsp` / `builtin:pi-team` / `builtin:pi-purge` 作为内置资源加载；
//   - 工具/命令真的注册进会话；
//   - `-builtin:<name>` 能关掉其中之一。
// 不需要真 subagent controller：团队工厂只在 spawn 时才用到它。
// pi-purge 不注册工具，只注册 `/purge` 命令与事件钩子——这里验证它加载不抛错，
// 且 `-builtin:pi-purge` 不影响其他扩展。

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-ext-builtins-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createPiExtensionBuiltins, PI_EXTENSION_BUILTIN_NAMES, TEAM_NAMING_SECTION, TEAM_PLAN_APPROVAL_SECTION } = await jiti.import("./pi-extension-builtins.ts");
const TEAM_BUILTIN_NAME = PI_EXTENSION_BUILTIN_NAMES[1];

test.after(() => rm(agentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

/** controller 桩：只是让工厂走「有宿主桥」分支；加载期不需要它的任何方法。 */
const stubController = {
  extensionRuntime: {
    async start() { throw new Error("not used in a load test"); },
    async resume() { throw new Error("not used in a load test"); },
    async get() { return null; },
    async steer() {},
    async notifyParent() {},
    markResultConsumed() {},
  },
  async get() { return null; },
  async steer() {},
  async abort() {},
};

async function loadSession(t, { settings = {}, extensionFactories = [] } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-ext-builtins-cwd-"));
  const faux = fauxProvider({ models: [{ id: "faux-ext" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory(settings);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      ...createPiExtensionBuiltins({ subagentController: stubController }),
      ...extensionFactories,
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel("faux-ext"),
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    resourceLoader,
  });
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return session;
}

function toolNames(session) {
  return session.getAllTools().map((tool) => tool.name);
}

test("builtin:pi-lsp loads and registers the lsp tool", async (t) => {
  const session = await loadSession(t);
  assert.ok(toolNames(session).includes("lsp"), `expected lsp in ${toolNames(session).join(",")}`);
});

test("builtin:pi-team loads and registers the team_* tools", async (t) => {
  const session = await loadSession(t);
  const names = toolNames(session);
  for (const tool of ["team_create", "team_message", "team_wait", "team_result", "team_status"]) {
    assert.ok(names.includes(tool), `expected ${tool} in ${names.join(",")}`);
  }
});

test("-builtin:pi-team in the extensions setting turns only pi-team off", async (t) => {
  const session = await loadSession(t, { settings: { extensions: ["-builtin:pi-team"] } });
  const names = toolNames(session);
  assert.ok(!names.includes("team_create"), "pi-team should be off");
  assert.ok(names.includes("lsp"), "pi-lsp should stay on");
});

test("-builtin:pi-lsp turns only pi-lsp off", async (t) => {
  const session = await loadSession(t, { settings: { extensions: ["-builtin:pi-lsp"] } });
  const names = toolNames(session);
  assert.ok(!names.includes("lsp"), "pi-lsp should be off");
  assert.ok(names.includes("team_create"), "pi-team should stay on");
});

test("builtin:pi-purge loads and registers without errors", async (t) => {
  // pi-purge 不注册工具，只注册 `/purge` 命令与 before_agent_start / session_start 钩子。
  // 能走到这里就证明工厂函数被调用且没有抛错。
  const session = await loadSession(t);
  assert.ok(toolNames(session).includes("lsp"), `expected lsp in ${toolNames(session).join(",")}`);
  assert.ok(toolNames(session).includes("team_create"), `expected team_create in ${toolNames(session).join(",")}`);
});

test("-builtin:pi-purge turns only pi-purge off", async (t) => {
  const session = await loadSession(t, { settings: { extensions: ["-builtin:pi-purge"] } });
  const names = toolNames(session);
  assert.ok(names.includes("lsp"), "pi-lsp should stay on");
  assert.ok(names.includes("team_create"), "pi-team should stay on");
});

test("a member session loads the member built-ins and a mailbox without dispatch", async (t) => {
  const { createSubagentBuiltinExtensions } = await jiti.import("./builtin-extensions.ts");
  const { createUnavailableTeamHost } = await jiti.import("./pi-team-host.ts");
  const { withSubagentExtensionTools } = await jiti.import("./subagents.ts");
  const member = await createSubagentBuiltinExtensions({ agentDir });
  const session = await loadSession(t, { extensionFactories: member.extensions });
  const names = toolNames(session);
  // codemode / tool-search are the token side (deferred tool declarations), lsp is code
  // navigation, and the team tools are the mailbox half.
  for (const tool of ["codemode", "tool_search", "lsp", "team_message", "team_status", "team_ticket"]) {
    assert.ok(names.includes(tool), `expected ${tool} in ${names.join(",")}`);
  }
  // MCP tool names only exist once a server connects, so the allow list carries the pattern.
  assert.ok(member.toolNames.includes("mcp__*"));
  // The mailbox half is not the whole pi-team surface: the same extension also registers the
  // lead-only team lifecycle tools. A subagent's allow-list is built from every loaded
  // extension's tools, so those names reach it unless withSubagentExtensionTools drops them —
  // and a member session reopened later carries no PI_AGENT_NAME, so pi-team's identity check
  // would let it delete its own team.
  for (const tool of ["team_create", "team_plan", "team_delete"]) {
    assert.ok(names.includes(tool), `expected the extension to register ${tool} (${names.join(",")})`);
  }
  const allowList = withSubagentExtensionTools(
    ["read", "bash", "edit", "write", "grep", "find", "ls"],
    [...member.toolNames, ...names],
  );
  for (const tool of ["team_create", "team_plan", "team_delete"]) {
    assert.ok(!allowList.includes(tool), `${tool} must not reach a subagent's allow-list`);
  }
  assert.ok(allowList.includes("team_message"), "the mailbox half must stay");
  // Dispatch is structurally impossible rather than merely intercepted: the member's
  // pi-team runs on the unavailable host, so a teammate cannot spawn a teammate.
  await assert.rejects(
    () => createUnavailableTeamHost().start({ name: "worker", task: "do it" }),
    /无法派发/,
  );
});

test("the team factory injects member identity synchronously and restores the env", async () => {
  // 后端-13 回归：身份必须经工厂**同步体**注入（pi-team 在构造期捕获 env），
  // 工厂返回后 env 必须恢复原状——进程里不许残留成员身份。
  process.env.PI_AGENT_NAME = "team-lead";
  delete process.env.PI_TEAM_NAME;
  const [team] = createPiExtensionBuiltins({
    include: [TEAM_BUILTIN_NAME],
    teamIdentity: { agentName: "worker-1", teamName: "crew" },
  });
  assert.equal(typeof team.factory, "function");
  const stubApi = {
    on() {},
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    subscribe() {},
  };
  // 工厂是同步的：set → pi-team 构造期捕获 → restore 之间没有任何 await。
  const pi = stubApi;
  await team.factory(pi);
  assert.equal(process.env.PI_AGENT_NAME, "team-lead", "factory must restore PI_AGENT_NAME");
  assert.equal(process.env.PI_TEAM_NAME, undefined, "factory must restore PI_TEAM_NAME");
  delete process.env.PI_AGENT_NAME;
});

/** 用捕获式 stub 装配团队扩展，拿到它注册的所有事件处理器。 */
async function capturedTeamExtension(identity) {
  const [team] = createPiExtensionBuiltins({
    include: [TEAM_BUILTIN_NAME],
    subagentController: stubController,
    ...(identity ? { teamIdentity: identity } : {}),
  });
  const handlers = [];
  const api = {
    on: (name, handler) => handlers.push([name, handler]),
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    subscribe() {},
    getAllTools: () => [],
  };
  await team.factory(api);
  const on = (name) => handlers.filter(([event]) => event === name).map(([, handler]) => handler);
  return { on };
}

test("the team naming hint is injected for a lead and withheld from a member", async () => {
  const lead = await capturedTeamExtension();
  const beforeAgentStart = lead.on("before_agent_start");
  assert.equal(beforeAgentStart.length, 1, "a lead must get the naming hint");
  const event = { systemPromptOptions: { sections: {} } };
  await beforeAgentStart[0](event);
  const guide = event.systemPromptOptions.sections[TEAM_NAMING_SECTION];
  assert.match(guide, /ASCII/);
  assert.match(guide, /description/);

  // Members do not create teams, so they must not get the hint.
  const member = await capturedTeamExtension({ agentName: "w1", teamName: "crew" });
  assert.equal(member.on("before_agent_start").length, 0, "a member must not get the naming hint");
});

test("team_create is blocked with the colliding team's display name when directory slugs clash", async () => {
  const teamsDir = await mkdtemp(join(tmpdir(), "pi-web-team-collision-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = teamsDir;
  try {
    // "前端队" and "后端队" both sanitize to the directory "---".
    await mkdir(join(teamsDir, "---"), { recursive: true });
    await writeFile(join(teamsDir, "---", "config.json"), JSON.stringify({ name: "前端队", members: [] }));

    const { on } = await capturedTeamExtension();
    const [toolCall] = on("tool_call");
    assert.equal(typeof toolCall, "function");

    const blocked = toolCall({ toolName: "team_create", input: { team_name: "后端队" } });
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /前端队/, "the message must name the existing team, not the requested one");
    assert.match(blocked.reason, /---/);

    // A distinct ASCII identifier does not collide, and other tools are untouched.
    assert.equal(toolCall({ toolName: "team_create", input: { team_name: "backend-crew" } }), undefined);
    assert.equal(toolCall({ toolName: "team_message", input: {} }), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(teamsDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("team_create is forced to spawn=false for the lead (review before launch), untouched for members", async () => {
  // Desktop policy (user decision 2026-11-12): the plan card always reviews first, so the
  // host rewrites team_create's spawn flag. pi-team reads `params.spawn !== false`, so both
  // an explicit `true` and an omitted value must become `false`.
  const lead = await capturedTeamExtension();
  const [leadToolCall] = lead.on("tool_call");

  const explicit = { toolName: "team_create", input: { team_name: "review-crew", spawn: true } };
  assert.equal(leadToolCall(explicit), undefined, "not a collision → no block");
  assert.equal(explicit.input.spawn, false, "explicit spawn=true is rewritten");

  const omitted = { toolName: "team_create", input: { team_name: "review-crew" } };
  leadToolCall(omitted);
  assert.equal(omitted.input.spawn, false, "missing spawn is filled in");

  // A member never creates teams; its hook must not touch the argument.
  const member = await capturedTeamExtension({ agentName: "w1", teamName: "crew" });
  const [memberToolCall] = member.on("tool_call");
  const memberInput = { toolName: "team_create", input: { team_name: "review-crew", spawn: true } };
  memberToolCall(memberInput);
  assert.equal(memberInput.input.spawn, true, "member hook leaves the argument alone");

  // Non-create tools are untouched.
  const other = { toolName: "team_message", input: {} };
  leadToolCall(other);
  assert.equal("spawn" in other.input, false);
});

test("the plan-approval guide is injected for the lead and withheld from members", async () => {
  const lead = await capturedTeamExtension();
  const event = { systemPromptOptions: { sections: {} } };
  await lead.on("before_agent_start")[0](event);
  const guide = event.systemPromptOptions.sections[TEAM_PLAN_APPROVAL_SECTION];
  assert.equal(typeof guide, "string", "lead must get the plan-approval section");
  assert.match(guide, /spawn=false/, "must name the forced flag");
  assert.match(guide, /team_plan/, "must point at the plan tool");
  assert.match(guide, /request_id/, "must name the approve idempotency key");
  assert.match(guide, /approve/, "must spell out the approve → launch sequence");

  const member = await capturedTeamExtension({ agentName: "w1", teamName: "crew" });
  assert.equal(member.on("before_agent_start").length, 0, "members must not get the guide");
});
