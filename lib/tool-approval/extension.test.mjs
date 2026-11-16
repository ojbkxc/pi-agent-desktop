import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 命令审批扩展的四条路径（mock ctx.ui，不碰 SDK、不碰真实宿主）：
 * 用户接受 → 放行；用户拒绝 → block；没有 UI → fail-open 放行；
 * confirm 抛异常 → fail-open 放行且只记一次日志。
 * 另外锁住：非 shell 工具、off 档、settings 读写、nested calls 与 input 不被修改。
 */

const jiti = createJiti(import.meta.url);
const {
  createToolApprovalExtension,
  APPROVAL_CONFIRM_TITLE,
  APPROVAL_CONFIRM_TIMEOUT_MS,
  APPROVAL_REJECTED_REASON,
  APPROVAL_TIMEOUT_REASON,
} = await jiti.import("./extension.ts");
const { readApprovalMode, writeApprovalMode, DEFAULT_APPROVAL_MODE } =
  await jiti.import("./settings.ts");

function makePi() {
  const handlers = new Map();
  return {
    handlers,
    on: (name, handler) => handlers.set(name, handler),
  };
}

/** 装好扩展，返回调用 tool_call handler 的句柄。 */
function setup({ mode = "dangerous", ui = "accept", log } = {}) {
  const pi = makePi();
  const confirmCalls = [];
  const logs = [];
  const ctx = {
    hasUI: ui !== "none",
    ui: ui === "none" ? undefined : {
      confirm: (title, message, opts) => {
        confirmCalls.push({ title, message, opts });
        if (ui === "throw") throw new Error("ui exploded");
        return Promise.resolve(ui === "accept");
      },
    },
  };
  createToolApprovalExtension({
    getMode: () => mode,
    log: log ?? ((message) => logs.push(message)),
  })(pi);
  return {
    confirmCalls,
    logs,
    event(event) {
      const handler = pi.handlers.get("tool_call");
      assert.ok(handler, "扩展必须注册 tool_call");
      return handler(event, ctx);
    },
  };
}

const bash = (command) => ({ toolName: "bash", toolCallId: "t-1", input: { command } });

// ───────────────────────── 四条路径 ─────────────────────────

test("注册了 tool_call；接受 → 放行（不返回结果）并展示标题/摘要", async () => {
  const s = setup({ ui: "accept" });
  const result = await s.event(bash("rm -rf build"));
  assert.equal(result, undefined);
  assert.equal(s.confirmCalls.length, 1);
  assert.equal(s.confirmCalls[0].title, APPROVAL_CONFIRM_TITLE);
  assert.match(s.confirmCalls[0].message, /rm -rf build/);
  assert.equal(s.logs.length, 0);
});

test("拒绝 → block:true，reason 是用户拒绝文案", async () => {
  const s = setup({ ui: "reject" });
  const result = await s.event(bash("rm -rf build"));
  assert.deepEqual(result, { block: true, reason: APPROVAL_REJECTED_REASON });
});

test("无 UI（headless / CI / e2e）→ fail-open 放行，不调用 confirm，记一次日志", async () => {
  const s = setup({ ui: "none" });
  const result = await s.event(bash("rm -rf build"));
  assert.equal(result, undefined);
  assert.equal(s.confirmCalls.length, 0);
  assert.match(s.logs[0], /fail-open/);

  // 第二、三次都不再记日志（只记一次）。
  await s.event(bash("rm -rf build"));
  await s.event(bash("rm -rf build"));
  assert.equal(s.logs.length, 1);
});

test("ctx.ui 存在但 confirm 不是函数 → 同样 fail-open", async () => {
  const pi = makePi();
  createToolApprovalExtension({ getMode: () => "dangerous", log: () => {} })(pi);
  const result = await pi.handlers.get("tool_call")(bash("rm -rf build"), { hasUI: true, ui: {} });
  assert.equal(result, undefined);
});

test("hasUI === false 时即使 ui.confirm 存在也放行（宿主明确说没有 UI）", async () => {
  const pi = makePi();
  createToolApprovalExtension({ getMode: () => "all", log: () => {} })(pi);
  const result = await pi.handlers.get("tool_call")(bash("npm test"), { hasUI: false, ui: { confirm: async () => false } });
  assert.equal(result, undefined);
});

test("confirm 抛异常 → fail-open 放行且只记一次日志", async () => {
  const s = setup({ ui: "throw" });
  const first = await s.event(bash("rm -rf build"));
  assert.equal(first, undefined);
  assert.equal(s.logs.length, 1);
  assert.match(s.logs[0], /confirm failed/);
  assert.match(s.logs[0], /fail-open/);

  await s.event(bash("rm -rf build"));
  assert.equal(s.logs.length, 1, "异常日志只记一次");
});

test("日志口自身抛异常也不影响放行", async () => {
  const s = setup({ ui: "throw", log: () => { throw new Error("log broken"); } });
  const result = await s.event(bash("rm -rf build"));
  assert.equal(result, undefined);
});

test("confirm 返回 undefined / 非 true → 视为拒绝", async () => {
  for (const value of [undefined, false, null, "yes", 1]) {
    const pi = makePi();
    createToolApprovalExtension({ getMode: () => "dangerous", log: () => {} })(pi);
    const result = await pi.handlers.get("tool_call")(bash("rm -rf build"), { hasUI: true, ui: { confirm: async () => value } });
    assert.deepEqual(result, { block: true, reason: APPROVAL_REJECTED_REASON }, String(value));
  }
});

// ───────────────────────── 放行口径 ─────────────────────────

test("非 shell 工具不读模式、不问 UI", async () => {
  const s = setup({ mode: "all", ui: "accept" });
  for (const toolName of ["read", "edit", "write", "grep", "find", "ls", "mcp_server_tool", "custom"]) {
    assert.equal(await s.event({ toolName, input: { command: "rm -rf /" } }), undefined, toolName);
  }
  assert.equal(s.confirmCalls.length, 0);
});

test("off 档：危险的 rm -rf 也直接放行，不弹窗", async () => {
  const s = setup({ mode: "off", ui: "accept" });
  assert.equal(await s.event(bash("rm -rf /")), undefined);
  assert.equal(s.confirmCalls.length, 0);
});

test("dangerous 档：未命中规则不弹窗", async () => {
  const s = setup({ mode: "dangerous", ui: "accept" });
  assert.equal(await s.event(bash("npm run build")), undefined);
  assert.equal(s.confirmCalls.length, 0);
});

test("all 档：普通命令也弹窗", async () => {
  const s = setup({ mode: "all", ui: "reject" });
  const result = await s.event(bash("npm run build"));
  assert.deepEqual(result, { block: true, reason: APPROVAL_REJECTED_REASON });
  assert.match(s.confirmCalls[0].message, /npm run build/);
});

test("getMode 抛异常 → 放行（读不到设置 = off）", async () => {
  const pi = makePi();
  createToolApprovalExtension({ getMode: () => { throw new Error("settings broken"); }, log: () => {} })(pi);
  const result = await pi.handlers.get("tool_call")(bash("rm -rf /"), { hasUI: true, ui: { confirm: async () => false } });
  assert.equal(result, undefined);
});

test("powershell 参与判定；nested call（parentToolCallId）同样拦截", async () => {
  const s = setup({ ui: "reject" });
  const nested = { toolName: "bash", toolCallId: "parent-1/2", parentToolCallId: "parent-1", input: { command: "rm -rf build" } };
  const result = await s.event(nested);
  assert.deepEqual(result, { block: true, reason: APPROVAL_REJECTED_REASON });

  const ps = await s.event({ toolName: "powershell", input: { command: "Remove-Item -Recurse -Force ." } });
  assert.deepEqual(ps, { block: true, reason: APPROVAL_REJECTED_REASON });
});

test("绝不修改 event.input（接受与拒绝两条路径）", async () => {
  for (const ui of ["accept", "reject"]) {
    const s = setup({ ui });
    const event = bash("rm -rf build");
    const before = JSON.stringify(event);
    await s.event(event);
    assert.equal(JSON.stringify(event), before, ui);
  }
});

// ───────────────────────── 设置读写与扩展接线 ─────────────────────────

test("设置：默认 off；写入后回读；其它键原样保留；坏文件读回 off", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-tool-approval-"));
  const path = join(dir, "pi-web", "settings.json");
  try {
    assert.equal(DEFAULT_APPROVAL_MODE, "off");
    assert.equal(readApprovalMode(path), "off", "缺文件 = off");
    assert.equal(writeApprovalMode("dangerous", path), "dangerous");
    assert.equal(readApprovalMode(path), "dangerous");
    assert.equal(writeApprovalMode("all", path), "all");
    assert.equal(writeApprovalMode("off", path), "off");

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, artifactsPrompt: false }));
    writeApprovalMode("dangerous", path);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      version: 1,
      artifactsPrompt: false,
      toolApprovalMode: "dangerous",
    });

    writeFileSync(path, "{not json");
    assert.equal(readApprovalMode(path), "off", "坏文件必须 fail-open（off）");

    writeFileSync(path, JSON.stringify({ toolApprovalMode: "bogus" }));
    assert.equal(readApprovalMode(path), "off", "非法值按 off");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("默认 getMode 读设置文件：改设置对下一次 tool_call 立即生效", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-tool-approval-live-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    // 不注入 getMode：走 settings.ts 的真实默认路径（$PI_CODING_AGENT_DIR/pi-web/settings.json）。
    const pi = makePi();
    createToolApprovalExtension({ log: () => {} })(pi);
    const ctx = { hasUI: true, ui: { confirm: async () => false } };
    const event = bash("rm -rf build");

    assert.equal(await pi.handlers.get("tool_call")(event, ctx), undefined, "默认 off");
    writeApprovalMode("dangerous");
    assert.deepEqual(await pi.handlers.get("tool_call")(event, ctx), {
      block: true,
      reason: APPROVAL_REJECTED_REASON,
    });
    writeApprovalMode("off");
    assert.equal(await pi.handlers.get("tool_call")(event, ctx), undefined, "改回 off 不再弹窗");
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});