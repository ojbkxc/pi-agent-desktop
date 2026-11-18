import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  toolCategory,
  toolGroupCategory,
  summarizeToolCalls,
  formatToolSummary,
  toolVerbKey,
} = await jiti.import("./tool-groups.ts");
const { englishMessages } = await jiti.import("./i18n/locale-plugins.ts");
const { interpolateMessage } = await jiti.import("./i18n/format.ts");

const t = (key, params) => interpolateMessage(englishMessages[key] ?? key, params ?? {});

test("maps tool names to summary verbs, leaving specialised views unlabelled", () => {
  assert.equal(toolCategory("read"), "read");
  assert.equal(toolCategory("bash"), "run");
  assert.equal(toolCategory("Edit"), "edit");
  assert.equal(toolCategory("write_file"), "write");
  assert.equal(toolCategory("WebFetch"), "fetch");
  assert.equal(toolCategory("glob"), "glob");
  // No verb: MCP is shown as server/tool, patches and codemode have their own views.
  assert.equal(toolCategory("apply_patch"), null);
  assert.equal(toolCategory("codemode"), null);
  assert.equal(toolCategory("mcp__srv__tool"), null);
  assert.equal(toolCategory("page_screenshot"), null);
});

test("only simple calls may fold into an inline row; edit and agent keep their cards", () => {
  assert.equal(toolGroupCategory("read"), "read");
  assert.equal(toolGroupCategory("bash"), "run");
  assert.equal(toolGroupCategory("web_fetch"), "fetch");
  assert.equal(toolGroupCategory("edit"), null);
  assert.equal(toolGroupCategory("Agent"), null);
  assert.equal(toolGroupCategory("apply_patch"), null);
  assert.equal(toolGroupCategory("codemode"), null);
  assert.equal(toolGroupCategory("mcp__srv__tool"), null);
});

test("summarizes a turn in first-seen order and counts repeated edits once per file", () => {
  const segments = summarizeToolCalls([
    { toolName: "read" },
    { toolName: "read" },
    { toolName: "bash" },
    { toolName: "edit", input: { file_path: "a.ts" } },
    { toolName: "edit", input: { file_path: "a.ts" } },
    { toolName: "edit", input: { file_path: "b.ts" } },
    { toolName: "mcp__srv__tool" },
    { toolName: "page_screenshot" },
  ]);
  assert.deepEqual(segments, [
    { category: "read", count: 2 },
    { category: "run", count: 1 },
    { category: "edit", count: 2 },
  ]);
});

test("formats the segments as cc-haha's localised verb phrase", () => {
  assert.equal(formatToolSummary([], t), "");
  assert.equal(formatToolSummary(summarizeToolCalls([{ toolName: "read" }]), t), "Read 1 file");
  assert.equal(
    formatToolSummary(summarizeToolCalls([{ toolName: "read" }, { toolName: "read" }, { toolName: "bash" }]), t),
    "Read 2 files, ran a command",
  );
  assert.equal(formatToolSummary(summarizeToolCalls([{ toolName: "glob" }]), t), "found files");
});

test("a call's short verb is localised except for agent, which keeps its own name", () => {
  assert.equal(toolVerbKey("read"), "toolVerb.read");
  assert.equal(toolVerbKey("run"), "toolVerb.run");
  assert.equal(toolVerbKey("agent"), null);
  assert.equal(toolVerbKey(null), null);
});
