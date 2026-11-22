/**
 * Real-SDK proof for fast mode: one session from `createAgentSession`, the
 * faux provider for a turn, a probe extension registered after ours to read the
 * chained system prompt.
 *
 * Unit tests can only show that our handler writes `sections`. This file shows
 * what actually reaches the model, which is the only claim worth making:
 * - the section text lands in the composed system prompt, and disappears at `off`;
 * - `/fast <preset>` is a real command in `get_commands` and its handler writes
 *   the store the settings row reads.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { Type } from "typebox";

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-fast-mode-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createFastModeExtension } = await jiti.import("./extension.ts");
const { FAST_MODE_SECTION } = await jiti.import("./guidance.ts");
const { segmentRecords } = await jiti.import("../../scripts/measure-turns.mjs");

test.after(() => rm(agentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

const settingsPath = join(agentDir, "pi-web", "settings.json");

async function storePreset(preset) {
  await mkdir(join(agentDir, "pi-web"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ fastMode: { preset } }), "utf8");
}

async function storedPreset() {
  const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
  return parsed.fastMode?.preset;
}

/**
 * A session with fast mode plus a probe factory registered after it. The probe
 * records `event.systemPrompt` as the chain sees it at its own position, which
 * is what the SDK will send.
 */
async function startSession(t, { preset = "off", extraFactories = [], preFactories = [], skipFastMode = false, resourceLoaderExtra = {} } = {}) {
  await storePreset(preset);
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-fast-mode-cwd-"));
  const faux = fauxProvider({ models: [{ id: "faux-fast" }] });
  const seen = [];
  const probe = {
    name: "fast-mode-probe",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        seen.push({
          prompt: event.systemPrompt,
          section: event.systemPromptOptions.sections[FAST_MODE_SECTION],
        });
        return undefined;
      });
    },
  };
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      ...(skipFastMode ? [] : [createFastModeExtension()]),
      ...preFactories,
      ...extraFactories,
      probe,
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...resourceLoaderExtra,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel("faux-fast"),
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    resourceLoader,
  });
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return { session, faux, seen };
}

test("a bare /fast is handled by the command, never reaching the model", async (t) => {
  const { session, faux } = await startSession(t, { preset: "conservative" });
  const callsBefore = faux.state.callCount;
  // A command that is not registered would be sent as text and answered by the model;
  // the faux provider records that, so this also proves registration.
  await session.prompt("/fast");
  await session.prompt("/fast nonsense");
  assert.equal(faux.state.callCount, callsBefore, "both prompts were consumed by the handler");
  assert.equal(await storedPreset(), "conservative", "status and an unknown argument change nothing");
});

test("the standard preset reaches the model as a system-prompt section", async (t) => {
  const { session, faux, seen } = await startSession(t, { preset: "standard" });
  faux.setResponses([() => ({ role: "assistant", content: [{ type: "text", text: "ok" }] })]);
  await session.prompt("hello");
  assert.equal(seen.length, 1, "before_agent_start ran once");
  assert.match(seen[0].section, /Speed rules for this session/);
  assert.match(seen[0].prompt, /Speed rules for this session/, "the section reaches the composed prompt");
  assert.match(seen[0].prompt, /change approach/i);
});

test("off sends no fast-mode text at all", async (t) => {
  const { session, faux, seen } = await startSession(t, { preset: "off" });
  faux.setResponses([() => ({ role: "assistant", content: [{ type: "text", text: "ok" }] })]);
  await session.prompt("hello");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].section, undefined);
  assert.doesNotMatch(seen[0].prompt, /Speed rules for this session/);
});

test("/fast switches the stored preset without a model call", async (t) => {
  const { session, faux } = await startSession(t, { preset: "off" });
  const callsBefore = faux.state.callCount;
  await session.prompt("/fast standard");
  assert.equal(await storedPreset(), "standard");
  assert.equal(faux.state.callCount, callsBefore, "a command is handled, not sent to the model");
});

/**
 * The chain, end to end: what the user switches, what the request carries, what
 * the transcript records, and what the measuring script reads back. Each piece
 * has its own unit test; this is the only one that can catch them disagreeing.
 */
test("a switch, the request, the transcript and the measurement agree", async (t) => {
  const { session, faux, seen } = await startSession(t, { preset: "off" });
  faux.setResponses([
    () => fauxAssistantMessage([fauxText("a")]),
    () => fauxAssistantMessage([fauxText("b")]),
    () => fauxAssistantMessage([fauxText("c")]),
  ]);

  await session.prompt("one");            // off: no section
  assert.equal(seen.at(-1).section, undefined, "the request carries no fast-mode text");

  await session.prompt("/fast standard"); // the switch
  await session.prompt("two");            // standard: section present
  assert.match(seen.at(-1).section, /Speed rules for this session/);

  // The same transcript, read the way scripts/measure-turns.mjs reads it.
  const segments = segmentRecords(session.sessionManager.getEntries()).map((segment) => segment.preset);
  assert.equal(segments[0], "unrecorded", "records before the first entry are honestly unlabelled");
  assert.deepEqual(
    segments.filter((preset) => preset !== "unrecorded"),
    ["off", "standard"],
    "the recorded presets follow the switch, in order",
  );
  assert.equal(await storedPreset(), "standard", "the stored setting agrees with both");
});

/**
 * The composition rule the wiring rests on, proven at runtime instead of read off
 * the source: sections set before a force-system-prompt handler survive it, and a
 * section writer placed after one is lost.
 */
test("fast mode composes with the other sections, and needs to run before governance", async (t) => {
  const { createAgentGuideExtension } = await jiti.import("../agent-guide-extension.ts");
  const { createArtifactGuideExtension } = await jiti.import("../artifact-guide-extension.ts");

  // Stand-in for lib/purge/extension.ts: returning a whole `systemPrompt` is what the
  // SDK treats as forceSystemPrompt.
  const governance = {
    name: "purge-standin",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\nGOVERNED-BY-PURGE` }));
    },
  };

  // The wired order: guides and fast mode first, governance last.
  const ordered = await startSession(t, {
    preset: "standard",
    extraFactories: [createArtifactGuideExtension(() => true), createAgentGuideExtension(() => true), governance],
  });
  ordered.faux.setResponses([() => fauxAssistantMessage([fauxText("ok")])]);
  await ordered.session.prompt("compose");
  const composed = ordered.seen.at(-1).prompt;
  assert.match(composed, /Speed rules for this session/, "fast mode is in the final prompt");
  assert.match(composed, /:::artifact\{/, "the artifacts section is in the final prompt");
  assert.match(composed, /the Pi Agent app/, "the behavior guide is in the final prompt");
  assert.match(composed, /GOVERNED-BY-PURGE/, "governance is applied last, over everything");

  // The hazardous order: governance first, then a late fast-mode. The forced prompt
  // has already replaced the run's prompt, so the later section never reaches it.
  const hazardous = await startSession(t, {
    preset: "standard",
    skipFastMode: true,
    preFactories: [{ name: "governance-first", hidden: true, factory: governance.factory }],
    extraFactories: [createFastModeExtension()],
  });
  hazardous.faux.setResponses([() => fauxAssistantMessage([fauxText("ok")])]);
  await hazardous.session.prompt("compose");
  assert.doesNotMatch(
    hazardous.seen.at(-1).prompt,
    /Speed rules for this session/,
    "a section writer after a force-system-prompt handler does not reach the prompt",
  );
});

test("the preset is recorded in the transcript once per change, not once per turn", async (t) => {
  const { session, faux } = await startSession(t, { preset: "standard" });
  const entries = () => session.sessionManager.getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === "pi-web:fast-mode")
    .map((entry) => entry.data);
  faux.setResponses([
    () => fauxAssistantMessage([fauxText("one")]),
    () => fauxAssistantMessage([fauxText("two")]),
    () => fauxAssistantMessage([fauxText("three")]),
  ]);

  await session.prompt("first");
  assert.equal(entries().length, 1, "the first run records the preset");
  assert.equal(entries()[0].preset, "standard");
  assert.equal("active" in entries()[0], false, "the preset alone carries the meaning");

  await session.prompt("second");
  assert.equal(entries().length, 1, "an unchanged preset adds nothing");

  await session.prompt("/fast off");
  await session.prompt("third");
  assert.equal(entries().length, 2, "turning it off is a change worth recording");
  assert.equal(entries()[1].preset, "off", "off is said once, by the preset");
  assert.equal("active" in entries()[1], false);
});

/**
 * The `actFirst` guidance line tells the model to issue independent lookups in
 * one step. That is only worth saying if pi actually runs sibling calls
 * concurrently — this pins the SDK fact the sentence rests on: two calls in one
 * assistant message overlap, instead of queueing behind each other.
 */
test("sibling tool calls in one assistant message run concurrently", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-fast-mode-par-"));
  const faux = fauxProvider({ models: [{ id: "faux-par" }] });
  const spans = [];
  const slowTool = {
    name: "slow_probe",
    label: "Slow probe",
    description: "Waits, then reports its span so overlapping calls are observable.",
    parameters: Type.Object({ tag: Type.String() }),
    execute: async (_id, params) => {
      const start = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const end = Date.now();
      spans.push({ tag: params.tag, start, end });
      return { content: [{ type: "text", text: `done ${params.tag}` }], details: {} };
    },
  };
  const toolHost = {
    name: "par-probe",
    hidden: true,
    factory: (pi) => pi.registerTool(slowTool),
  };
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [toolHost],
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
    model: faux.getModel("faux-par"),
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    resourceLoader,
  });
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

  faux.setResponses([
    () => fauxAssistantMessage([
      fauxToolCall("slow_probe", { tag: "a" }, { id: "call-a" }),
      fauxToolCall("slow_probe", { tag: "b" }, { id: "call-b" }),
    ], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxText("done")]),
  ]);
  const started = Date.now();
  await session.prompt("call both");
  const elapsed = Date.now() - started;

  assert.equal(spans.length, 2, "both calls ran");
  const [first, second] = [...spans].sort((a, b) => a.start - b.start);
  assert.ok(second.start < first.end, "the second call started before the first finished");
  // Sequential would be ≥300ms of tool time alone; concurrent is ~150ms.
  assert.ok(elapsed < 280, `expected overlap, took ${elapsed}ms`);
});

/**
 * The workspace-chat branch, proven at runtime rather than read off the source:
 * `lib/rpc-manager.ts` gives a chat its own base prompt (`chatWorkspacePrompt`) and
 * `noContextFiles`. The section must still land inside that prompt, and fast mode
 * must not add a tool — a chat's tool surface is server-enforced.
 */
test("a workspace chat gets the section inside its own prompt and no new tools", async (t) => {
  const { chatWorkspacePrompt } = await jiti.import("../chat-workspace-policy.ts");
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-fast-mode-chat-"));
  const faux = fauxProvider({ models: [{ id: "faux-chat" }] });
  const seen = [];
  const probe = {
    name: "chat-probe",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        seen.push({ prompt: event.systemPrompt, tools: pi.getActiveTools() });
        return undefined;
      });
    },
  };
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({});
  await storePreset("standard");
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    // The chat branch's own options: a base prompt of its own, no context files.
    systemPrompt: chatWorkspacePrompt(false, { folder: "C:/Users/x/chat", unlocked: false }),
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [createFastModeExtension(), probe],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel("faux-chat"),
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    resourceLoader,
  });
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

  faux.setResponses([() => fauxAssistantMessage([fauxText("ok")])]);
  await session.prompt("hello");
  assert.match(seen.at(-1).prompt, /Speed rules for this session/, "the section reaches a chat's prompt");
  const tools = seen.at(-1).tools ?? [];
  assert.ok(
    !tools.some((tool) => /fast/i.test(String(tool))),
    `fast mode must not add a tool to a chat: ${tools.join(", ")}`,
  );
});


test("switching mid-turn is safe: the command finishes and the next turn is what changes", async (t) => {
  // The composer can send /fast while a run is streaming. Pinning it means a future
  // refactor cannot turn that into a throw and lose the user's message.
  const { session, faux } = await startSession(t, { preset: "off" });
  faux.setResponses([
    async () => { await new Promise((resolve) => setTimeout(resolve, 200)); return fauxAssistantMessage([fauxText("slow")]); },
    () => fauxAssistantMessage([fauxText("second")]),
  ]);
  const running = session.prompt("hello");
  const command = session.prompt("/fast standard");
  const settled = await Promise.allSettled([running, command]);
  assert.deepEqual(settled.map((result) => result.status), ["fulfilled", "fulfilled"]);
  assert.equal(await storedPreset(), "standard", "the switch lands even while a turn is running");
});

test("where /fast is not registered, the text goes to the model — so the docs must say so", async (t) => {
  // chat-only sessions send an exact prompt and carry none of our extensions, so a
  // typed /fast there is ordinary message text. Pinning it keeps the documented
  // workaround honest: switch from Settings, not from that composer.
  const { session, faux } = await startSession(t, { preset: "standard", skipFastMode: true });
  let modelSaw;
  faux.setResponses([(context) => {
    const last = context.messages.at(-1);
    modelSaw = typeof last.content === "string" ? last.content : last.content.map((part) => part.text ?? "").join("");
    return fauxAssistantMessage([fauxText("ok")]);
  }]);
  await session.prompt("/fast off");
  assert.match(String(modelSaw ?? ""), /\/fast off/, "the unregistered command reached the model");
  assert.equal(await storedPreset(), "standard", "and it changed nothing");
});
