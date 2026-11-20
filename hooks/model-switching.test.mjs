import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const loadSessionSource = source.slice(
  source.indexOf("const loadSession = useCallback"),
  source.indexOf("const loadContext = useCallback"),
);
const switchSource = source.slice(
  source.indexOf("const handleModelChange = useCallback"),
  source.indexOf("const handleCompact = useCallback"),
);

test("existing-session model changes are optimistic and serialized", () => {
  const optimisticIndex = switchSource.indexOf("setCurrentModelOverride(target)");
  const requestIndex = switchSource.indexOf("await sendAgentCommand", optimisticIndex);

  assert.match(switchSource, /if \(!sid \|\| modelSwitchPendingRef\.current\) return/);
  assert.ok(optimisticIndex >= 0);
  assert.ok(requestIndex > optimisticIndex);
  assert.match(switchSource, /setModelSwitching\(true\)/);
  assert.match(switchSource, /setModelSwitching\(false\)/);
});

test("session reloads cannot clear an in-flight optimistic model", () => {
  assert.match(
    loadSessionSource,
    /setCurrentModelOverride\(\(current\) => modelSwitchPendingRef\.current \? current : null\)/,
  );
});

test("a completed model switch reloads (idle) or live-syncs (mid-run) and reports failures", () => {
  // A switch during a run must not reload the session file — that would replace
  // the run's streaming messages. It takes the model and level from the live
  // state instead; an idle switch reloads the canonical session as before.
  assert.match(switchSource, /const midRun = agentRunningRef\.current \|\| bashRunningRef\.current/);
  assert.match(
    switchSource,
    /if \(midRun\) \{[\s\S]*?setCurrentModelOverride\(null\);[\s\S]*?await syncLiveState\(\);[\s\S]*?\} else \{[\s\S]*?await loadSession\(sid\)/,
  );
  assert.match(
    switchSource,
    /setCurrentModelOverride\(previousOverride\)[\s\S]*?if \(midRun\) await syncLiveState\(\);\s*else await loadSession\(sid, false, true\)/,
  );
  assert.match(switchSource, /setCurrentModelOverride\(previousOverride\)/);
  assert.match(switchSource, /Failed to switch model:/);
});
