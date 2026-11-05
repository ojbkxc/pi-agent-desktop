import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
//   - `builtin:pi-lsp` / `builtin:pi-team` 作为内置资源加载；
//   - 工具真的注册进会话工具面；
//   - `-builtin:<name>` 能关掉其中之一。
// 不需要真 subagent controller：团队工厂只在 spawn 时才用到它。

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-ext-builtins-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createPiExtensionBuiltins } = await jiti.import("./pi-extension-builtins.ts");

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
