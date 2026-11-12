import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isMcpTool, isReadOnlySelection } = await jiti.import("./mcp-read-only-policy.ts");

test("a pinned selection is read-only when it names tools and none can write or run commands", () => {
  assert.equal(isReadOnlySelection(["read", "grep", "find", "ls"]), true);
  assert.equal(isReadOnlySelection(["read"]), true);
  // No pin follows pi's configured tools, and an empty pin is Chat only, which loads no MCP.
  assert.equal(isReadOnlySelection(undefined), false);
  assert.equal(isReadOnlySelection([]), false);
  for (const writer of ["bash", "powershell", "edit", "write"]) {
    assert.equal(isReadOnlySelection(["read", writer]), false, writer);
    // `+name` 形态（在 defaultTools 之上强开内置工具）同样是可变会话：
    // 不剥掉 `+` 会把它误判成只读，所有 MCP 写工具都会被拦（2026-11-12 实锤）。
    assert.equal(isReadOnlySelection(["read", `+${writer}`]), false, `+${writer}`);
    assert.equal(isReadOnlySelection([`+${writer}`]), false, `only +${writer}`);
  }
  // `+read` 这类只读修饰形态（全量工具里没有写工具）仍然算只读。
  assert.equal(isReadOnlySelection(["+read", "+grep", "+find", "+ls"]), true);
});

test("MCP tools are the MCP extension's and any named mcp__", () => {
  const source = (path) => ({ path, source: "builtin", scope: "user", origin: "top-level" });
  assert.equal(isMcpTool({ name: "read_mcp_resource", sourceInfo: source("builtin:mcp") }), true);
  assert.equal(isMcpTool({ name: "mcp__docs__search", sourceInfo: source("/ext/other-mcp.ts") }), true);
  assert.equal(isMcpTool({ name: "web_search", sourceInfo: source("/ext/search.ts") }), false);
  assert.equal(isMcpTool({ name: "codemode", sourceInfo: source("builtin:codemode") }), false);
});

test("a teammate's read-only snapshot blocks write-capable MCP tools", async () => {
  const { createReadOnlyMcpPolicyExtension } = await jiti.import("./mcp-read-only-policy.ts");
  const { SUBAGENT_META_TYPE } = await jiti.import("./subagents.ts");

  let onToolCall;
  const pi = {
    getAllTools: () => [{ name: "mcp__docs__write", sourceInfo: { path: "builtin:mcp" }, annotations: {} }],
    on: (event, handler) => { if (event === "tool_call") onToolCall = handler; },
  };
  createReadOnlyMcpPolicyExtension().factory(pi);

  // A subagent session never writes a pi-web:tool-selection entry; its pinned tools live in
  // the pi-web:subagent snapshot. Reading only the former left an explore/plan teammate free
  // to write through MCP while its coding tools stayed read-only.
  const ctxFor = (tools) => ({
    sessionManager: {
      getEntries: () => [{
        type: "custom",
        customType: SUBAGENT_META_TYPE,
        data: {
          version: 1,
          parentSessionId: "parent",
          parentSessionPath: "/tmp/parent.jsonl",
          // A member snapshot always carries loadExtensions: true, which is what lets a
          // name outside the coding built-ins (mcp__*) survive the snapshot's validation.
          resourceSnapshot: { version: 1, appendSystemPrompt: [], tools, loadExtensions: true },
        },
      }],
    },
  });

  const blocked = onToolCall({ toolName: "mcp__docs__write" }, ctxFor(["read", "grep", "find", "ls", "mcp__*"]));
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /read-only tool selection/);
  // A member that may write keeps its MCP tools.
  assert.equal(onToolCall({ toolName: "mcp__docs__write" }, ctxFor(["read", "bash", "mcp__*"])), undefined);
  // A snapshot that is not a read-only selection, and a session with no snapshot at all.
  assert.equal(onToolCall({ toolName: "mcp__docs__write" }, ctxFor([])), undefined);
  assert.equal(onToolCall({ toolName: "mcp__docs__write" }, { sessionManager: { getEntries: () => [] } }), undefined);
});
