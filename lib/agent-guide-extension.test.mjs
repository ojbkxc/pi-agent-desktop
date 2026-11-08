import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AGENT_GUIDE, AGENT_GUIDE_SECTION, createAgentGuideExtension } = await jiti.import("./agent-guide-extension.ts");
const { isAgentGuidePromptEnabled, writeAgentGuidePromptEnabled } = await jiti.import("./agent-guide-settings.ts");

test("adds the agent-guide section without forcing the prompt", async () => {
  const handlers = [];
  const extension = createAgentGuideExtension();
  assert.equal(extension.hidden, true);
  await extension.factory({ on: (name, handler) => handlers.push([name, handler]) });
  assert.deepEqual(handlers.map(([name]) => name), ["before_agent_start"]);

  const event = { systemPromptOptions: { sections: {} } };
  const result = await handlers[0][1](event);
  assert.equal(result, undefined);
  assert.equal(event.systemPromptOptions.sections[AGENT_GUIDE_SECTION], AGENT_GUIDE);
});

test("the guide never claims a capability the app does not have", () => {
  // #23 audited every prompt claim against the implementation; the guide must
  // not reintroduce any: no MCP names, no skills lists, no user-only commands.
  for (const forbidden of ["web-toolbox", "gcloud", "tavily", "playwright", "/rewind", "/usage", "/websearch", "/goal-", "skill:"]) {
    assert.ok(!AGENT_GUIDE.includes(forbidden), `guide must not mention ${forbidden}`);
  }
  assert.ok(AGENT_GUIDE.includes("concise"), "concise-first stays the top rule");
});

test("leaves the section out, and removes it, when the setting is off", async () => {
  let enabled = true;
  const handlers = [];
  await createAgentGuideExtension(() => enabled).factory({ on: (name, handler) => handlers.push(handler) });
  const event = { systemPromptOptions: { sections: {} } };
  await handlers[0](event);
  assert.ok(event.systemPromptOptions.sections[AGENT_GUIDE_SECTION]);
  enabled = false;
  await handlers[0](event);
  assert.equal(AGENT_GUIDE_SECTION in event.systemPromptOptions.sections, false);
});

test("the settings switch defaults to on, persists, and survives a broken file", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-guide-settings-"));
  try {
    const settingsPath = join(dir, "pi-web", "settings.json");
    assert.equal(isAgentGuidePromptEnabled(settingsPath), true, "missing file keeps it on");
    assert.equal(writeAgentGuidePromptEnabled(false, settingsPath), false);
    assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).agentGuidePrompt, false);
    // An existing unrelated key survives the merge write.
    writeAgentGuidePromptEnabled(true, settingsPath);
    const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(stored.agentGuidePrompt, true);
    assert.equal(stored.version, 1);

    writeFileSync(settingsPath, "{not json");
    assert.equal(isAgentGuidePromptEnabled(settingsPath), true, "unreadable file keeps it on");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
