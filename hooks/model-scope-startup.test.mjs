import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");

test("new-session startup sends only explicit browser overrides", () => {
  const ensureSource = source.slice(
    source.indexOf("const ensureNewSession"),
    source.indexOf("const loadSlashCommands"),
  );

  assert.match(ensureSource, /const selectedModel = newSessionModelOverrideRef\.current;/);
  assert.doesNotMatch(ensureSource, /newSessionModel \?\? newSessionDefaultModel/);
  assert.match(ensureSource, /const selectedThinkingLevel = thinkingLevelOverrideRef\.current;/);
  assert.doesNotMatch(ensureSource, /thinkingLevel !== "auto"/);
});

test("new-session startup adopts server state only while explicit overrides are unchanged", () => {
  const ensureSource = source.slice(
    source.indexOf("const ensureNewSession"),
    source.indexOf("const loadSlashCommands"),
  );
  // 7e2a1c1c pulled the adoption into applyNewSessionStartState() so the
  // session_start dialog path can re-read get_state through the same guard.
  const applySource = source.slice(
    source.indexOf("const applyNewSessionStartState = useCallback("),
    source.indexOf("const ensureNewSession"),
  );

  assert.match(
    applySource,
    /state\.model && newSessionModelOverrideRef\.current === selectedModel/,
  );
  assert.match(applySource, /setPendingModel\(state\.model\)/);
  assert.match(applySource, /setNewSessionDefaultModel\(state\.model\)/);
  assert.match(
    applySource,
    /thinkingLevelOverrideRef\.current === selectedThinkingLevel/,
  );
  assert.match(applySource, /setLiveThinkingLevel\(asConcreteThinkingLevel\(state\.thinkingLevel\)\)/);
  assert.match(applySource, /setNewSessionDefaultThinkingLevel\(asConcreteThinkingLevel\(state\.thinkingLevel\)\)/);
  // ensureNewSession still routes its answer through that one guard.
  assert.match(ensureSource, /applyNewSessionStartState\(result, selectedModel, selectedThinkingLevel\)/);
});

test("model-list refresh does not overwrite a live session or explicit thinking override", () => {
  const loadModelsSource = source.slice(
    source.indexOf("const loadModels = useCallback"),
    source.indexOf("const handleBuiltinSlashCommand"),
  );

  assert.match(loadModelsSource, /if \(isNew && !sessionIdRef\.current\)/);
  assert.match(
    loadModelsSource,
    /thinkingLevelOverrideRef\.current === null/,
  );
  assert.match(loadModelsSource, /setNewSessionDefaultThinkingLevel\(/);
  assert.doesNotMatch(loadModelsSource, /setThinkingLevel\(/);
});
