import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const sourceText = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("useAgentSession.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
// The summary itself lives in the fork-owned hook; useAgentSession only consumes it.
const branchSummaryText = readFileSync(new URL("./useBranchSummary.ts", import.meta.url), "utf8");
const branchSummarySource = ts.createSourceFile("useBranchSummary.ts", branchSummaryText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function find(node, match) {
  if (match(node)) return node;
  return ts.forEachChild(node, (child) => find(child, match));
}

function compile(text) {
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText.trim().replace(/;$/, "");
}

const helperNode = find(branchSummarySource, (n) => ts.isFunctionDeclaration(n) && n.name?.text === "branchSummaryHolds");
const leafChangeNode = find(source, (n) => ts.isVariableDeclaration(n) && n.name.getText(source) === "handleLeafChange");
assert.ok(helperNode, "branchSummaryHolds not found");
assert.ok(leafChangeNode, "handleLeafChange not found");

const helperJs = compile(helperNode.getText(branchSummarySource).replace(/^export /, ""));
const branchSummaryHolds = new Script(`${helperJs}; branchSummaryHolds`).runInNewContext({});

function leafChangeHarness({ pendingSummarySessionId, currentSessionId, loadContextResult = false }) {
  const calls = { activeLeaf: [], summarize: [], loadContext: [] };
  const context = {
    branchSummaryHolds,
    bashRunningRef: { current: false },
    agentRunningRef: { current: false },
    isCompacting: false,
    branchSummarySessionIdRef: { current: pendingSummarySessionId },
    sessionIdRef: { current: currentSessionId },
    sessionReadIdRef: { current: 0 },
    activeLeafIdRef: { current: "leaf-0" },
    summarizeAndNavigate: async (leafId) => { calls.summarize.push(leafId); },
    setActiveLeafId: (leafId) => { calls.activeLeaf.push(leafId); },
    invalidateSessionData: () => {},
    loadContext: async (sid, leafId) => { calls.loadContext.push([sid, leafId]); return loadContextResult; },
    sendAgentCommand: async () => {},
    addNotice: () => {},
    t: (key) => key,
  };
  const handlerJs = compile(leafChangeNode.initializer.arguments[0].getText(source));
  const handleLeafChange = new Script(`(${handlerJs})`).runInNewContext(context);
  return { handleLeafChange, calls };
}

test("a branch summary holds only the session it is summarizing", () => {
  assert.equal(branchSummaryHolds(null, null), false);
  assert.equal(branchSummaryHolds(null, "a"), false);
  assert.equal(branchSummaryHolds("a", "a"), true);
  assert.equal(branchSummaryHolds("a", "b"), false);
  assert.equal(branchSummaryHolds("a", null), false);
});

test("a summary still running for the previous session does not lock branch switches in the next", async () => {
  const { handleLeafChange, calls } = leafChangeHarness({ pendingSummarySessionId: "a", currentSessionId: "b" });
  await handleLeafChange("leaf-1");
  assert.deepEqual(calls.activeLeaf, ["leaf-1"]);
  assert.deepEqual(calls.loadContext, [["b", "leaf-1"]]);
});

test("a failed navigate_tree rolls the view back to the branch the agent is on", async () => {
  const calls = { activeLeaf: [], loadContext: [], notices: [] };
  const context = {
    branchSummaryHolds,
    bashRunningRef: { current: false },
    agentRunningRef: { current: false },
    isCompacting: false,
    branchSummarySessionIdRef: { current: null },
    sessionIdRef: { current: "a" },
    sessionReadIdRef: { current: 0 },
    activeLeafIdRef: { current: "leaf-0" },
    summarizeAndNavigate: async () => {},
    setActiveLeafId: (leafId) => { calls.activeLeaf.push(leafId); },
    invalidateSessionData: () => {},
    loadContext: async (sid, leafId) => { calls.loadContext.push([sid, leafId]); return true; },
    sendAgentCommand: async () => { throw new Error("navigation rejected"); },
    addNotice: (notice) => { calls.notices.push(notice.type); },
    t: (key) => key,
  };
  const handlerJs = compile(leafChangeNode.initializer.arguments[0].getText(source));
  const handleLeafChange = new Script(`(${handlerJs})`).runInNewContext(context);
  await handleLeafChange("leaf-1");
  // Optimistic switch to leaf-1, then the rollback restores leaf-0 and reloads it.
  assert.deepEqual(calls.activeLeaf, ["leaf-1", "leaf-0"]);
  assert.deepEqual(calls.loadContext, [["a", "leaf-1"], ["a", "leaf-0"]]);
  assert.deepEqual(calls.notices, ["error"]);
});

test("a summary running for the current session still locks its branch switches", async () => {
  const { handleLeafChange, calls } = leafChangeHarness({ pendingSummarySessionId: "a", currentSessionId: "a" });
  await handleLeafChange("leaf-1");
  await handleLeafChange("leaf-2", { summarize: true });
  assert.deepEqual(calls.activeLeaf, []);
  assert.deepEqual(calls.summarize, []);
});

test("send, branch switch and the lock banner all scope the summary to the current session", () => {
  const sendSource = sourceText.slice(
    sourceText.indexOf("  const handleSend = useCallback"),
    sourceText.indexOf("  const handleSend = useCallback") + 600,
  );
  assert.match(sendSource, /if \(agentRunningRef\.current \|\| bashRunningRef\.current \|\| branchSummaryHolds\(branchSummarySessionIdRef\.current, sessionIdRef\.current\)\) \{/);
  assert.match(branchSummaryText, /const branchSummaryPending = branchSummaryHolds\(branchSummarySessionId, sessionId\);/);
  assert.match(sourceText, /useBranchSummary\(\{\s*sessionId: session\?\.id \?\? null,/);
  // No run/busy guard may test the bare ref: it still holds the previous session's id after a switch.
  // (summarizeAndNavigate's own `!sid || branchSummarySessionIdRef.current` keeps summaries single-flight.)
  for (const text of [sourceText, branchSummaryText]) {
    assert.doesNotMatch(text, /(?:Ref\.current|isCompacting) \|\| branchSummarySessionIdRef\.current\)/);
  }
});
