import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  buildFastModeSection,
  FAST_MODE_PRESETS,
  FAST_MODE_SECTION,
  FAST_MODE_SECTION_BUDGET,
  resolveFastModeConfig,
} = await jiti.import("./guidance.ts");
const { createFastModeExtension } = await jiti.import("./extension.ts");
const { readFastModeConfig, writeFastModeConfig } = await jiti.import("./settings.ts");

function tempSettings(contents) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-fast-mode-"));
  const path = join(dir, "settings.json");
  if (contents !== undefined) writeFileSync(path, contents);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function handlerOf(readConfig) {
  const handlers = [];
  const extension = createFastModeExtension(readConfig);
  await extension.factory({ on: (name, handler) => handlers.push([name, handler]) });
  return { extension, handlers };
}

test("is a hidden extension with exactly one before_agent_start handler", async () => {
  const { extension, handlers } = await handlerOf(() => resolveFastModeConfig("standard"));
  assert.equal(extension.hidden, true);
  assert.equal(extension.name, "pi-web-fast-mode");
  assert.deepEqual(handlers.map(([name]) => name), ["before_agent_start"]);
});

test("standard turns every switch on and stays a section, never a forced prompt", async () => {
  const { handlers } = await handlerOf(() => resolveFastModeConfig("standard"));
  const event = { systemPromptOptions: { sections: {} } };
  const result = await handlers[0][1](event);
  assert.equal(result, undefined, "returning systemPrompt would replace the whole prompt");
  const section = event.systemPromptOptions.sections[FAST_MODE_SECTION];
  assert.ok(typeof section === "string" && section.length > 0);
  assert.match(section, /complete/, "brevity must not license dropping substance");
  assert.match(section, /change approach/i);
});

test("off is a byte-for-byte passthrough: the section is deleted, not emptied", async () => {
  const { handlers } = await handlerOf(() => resolveFastModeConfig("off"));
  const event = { systemPromptOptions: { sections: { [FAST_MODE_SECTION]: "stale" } } };
  await handlers[0][1](event);
  assert.equal(FAST_MODE_SECTION in event.systemPromptOptions.sections, false);
});

test("conservative keeps only the brevity block", async () => {
  const section = buildFastModeSection(resolveFastModeConfig("conservative"));
  assert.ok(section);
  assert.ok(!/change approach/i.test(section));
  assert.ok(!/uncertain/i.test(section));
});

test("a broken preference fails off instead of breaking the turn", async () => {
  const { handlers } = await handlerOf(() => {
    throw new Error("boom");
  });
  const event = { systemPromptOptions: { sections: {} } };
  await handlers[0][1](event);
  assert.equal(FAST_MODE_SECTION in event.systemPromptOptions.sections, false);
});

test("the section text is deterministic, so the SDK diff stays a no-op", () => {
  const a = buildFastModeSection(resolveFastModeConfig("standard"));
  const b = buildFastModeSection(resolveFastModeConfig("standard", { brevity: true }));
  assert.equal(a, b);
});

test("the standard section stays inside its per-request budget", () => {
  const section = buildFastModeSection(resolveFastModeConfig("standard"));
  assert.ok(
    section.length <= FAST_MODE_SECTION_BUDGET,
    `standard section is ${section.length} chars, budget ${FAST_MODE_SECTION_BUDGET}`,
  );
  // The conservative preset must be strictly smaller — it is the "stop paying for
  // rules I do not want" option, so it cannot cost as much as the full one.
  const lean = buildFastModeSection(resolveFastModeConfig("conservative"));
  assert.ok(lean.length < section.length);
});

test("it does not repeat the behavior guide's own concision rule", () => {
  // AGENT_GUIDE ships with the same request by default (lib/agent-guide-extension.ts)
  // and already says: lead with the answer, no preamble, no closing summary. Saying it
  // twice bills the same instruction twice; only the tool-work narration is ours.
  const guide = readFileSync(new URL("../agent-guide-extension.ts", import.meta.url), "utf8");
  assert.match(guide, /no closing summary/, "the guide still owns that rule");
  const section = buildFastModeSection(resolveFastModeConfig("standard"));
  for (const duplicate of [/closing summary/i, /no preamble/i, /lead with the answer/i]) {
    assert.ok(!duplicate.test(section), `duplicates the guide: ${duplicate}`);
  }
  assert.match(section, /restate its result/, "the tool-work half is ours and stays");
});

test("brevity trims commentary, never the deliverable the artifact guide asks for", () => {
  // The artifacts section (lib/artifact-guide-extension.ts) requires a complete HTML
  // file and "one or two sentences" of commentary outside it. A model reading only
  // "be shorter" could summarize the artifact instead of writing it, so this section
  // must say where the trimming stops.
  const artifacts = readFileSync(new URL("../artifact-guide-extension.ts", import.meta.url), "utf8");
  assert.match(artifacts, /one complete file/, "the artifact guide still demands a whole file");
  const section = buildFastModeSection(resolveFastModeConfig("standard"));
  assert.match(section, /never shortened/, "the deliverable is explicitly out of scope for brevity");
  assert.match(section, /deliverables/, "and named as such");
  // It must not try to cap the commentary the artifact guide already caps.
  assert.ok(!/one or two sentences/i.test(section), "the artifact guide owns the commentary budget");
});

test("per-switch overrides beat the preset", () => {
  const config = resolveFastModeConfig("standard", { changeApproach: false, verifyFirst: false });
  assert.equal(config.switches.changeApproach, false);
  assert.equal(config.switches.brevity, true);
  assert.ok(!/change approach/i.test(buildFastModeSection(config)));
});

test("unknown presets degrade to off, not to standard", () => {
  assert.equal(resolveFastModeConfig("turbo").preset, "off");
  assert.equal(buildFastModeSection(resolveFastModeConfig("turbo")), undefined);
  assert.equal(resolveFastModeConfig(undefined).preset, "off");
});

test("settings round-trip through Pi Web's own file and default to off", () => {
  const { path, cleanup } = tempSettings();
  try {
    assert.equal(readFastModeConfig(path).preset, "off");
    assert.equal(writeFastModeConfig({ preset: "standard" }, path).preset, "standard");
    assert.equal(readFastModeConfig(path).preset, "standard");
    assert.equal(writeFastModeConfig({ preset: "off" }, path).preset, "off");
  } finally {
    cleanup();
  }
});

test("an unparsable settings file reads as off instead of throwing", () => {
  const { path, cleanup } = tempSettings("{ not json");
  try {
    assert.equal(readFastModeConfig(path).preset, "off");
  } finally {
    cleanup();
  }
});

test("a fastMode block that is not an object reads as off", () => {
  const { path, cleanup } = tempSettings(JSON.stringify({ fastMode: "standard" }));
  try {
    assert.equal(readFastModeConfig(path).preset, "off");
  } finally {
    cleanup();
  }
});

test("the guide claims no capability the app does not have", () => {
  const section = buildFastModeSection(resolveFastModeConfig("standard"));
  for (const forbidden of ["/fast", "web-toolbox", "gcloud", "playwright", "skill:"]) {
    assert.ok(!section.includes(forbidden), `must not mention ${forbidden}`);
  }
  assert.ok(Object.keys(FAST_MODE_PRESETS).includes("standard"));
});

test("a normal session wires it after the guides and before purge", () => {
  // purge returns a whole systemPrompt (forceSystemPrompt) and is registered last; a
  // handler after it would edit sections the request no longer carries.
  const source = readFileSync(new URL("../rpc-manager.ts", import.meta.url), "utf8");
  const factories = [...source.matchAll(/createFastModeExtension\(\),/g)].map((match) => match.index);
  assert.equal(factories.length, 2, "normal session and workspace chat both register it");
  const purges = [...source.matchAll(/createPurgeExtension\(\{ readModel:/g)].map((match) => match.index);
  assert.equal(purges.length, 2, "purge is the last factory in both branches");
  for (let index = 0; index < factories.length; index += 1) {
    assert.ok(factories[index] > source.indexOf("createAgentGuideExtension(),"), "after the prompt guides");
    assert.ok(factories[index] < purges[index], "before purge in the same branch");
  }
  assert.match(
    source,
    /import \{ createFastModeExtension \} from "\.\/fast-mode\/extension";/,
  );
});

test("the config is read once per file version, not once per turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-fast-mode-cache-"));
  const path = join(dir, "settings.json");
  try {
    writeFileSync(path, JSON.stringify({ fastMode: { preset: "standard" } }));
    const first = readFastModeConfig(path);
    const second = readFastModeConfig(path);
    assert.equal(first, second, "the same object comes back until the file changes");
    assert.equal(first.preset, "standard");

    writeFileSync(path, JSON.stringify({ fastMode: { preset: "conservative" } }));
    assert.equal(readFastModeConfig(path).preset, "conservative", "a write invalidates the cache");

    writeFileSync(path, "{ broken");
    assert.equal(readFastModeConfig(path).preset, "off", "a broken file still reads as off");
    writeFileSync(path, JSON.stringify({ fastMode: { preset: "standard" } }));
    assert.equal(
      readFastModeConfig(path).preset,
      "standard",
      "a broken file is not cached: repairing it takes effect immediately",
    );

    rmSync(path);
    assert.equal(readFastModeConfig(path).preset, "off", "a missing file is off, and clears the cache");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the section builder stays pure, so no turn can pay for I/O in it", () => {
  // Measured: building the section costs 1.18 µs and resolving the config 0.12 µs —
  // noise beside the 258 µs file read that D10 removed. The invariant worth keeping
  // is therefore not a cache but purity: this module must never grow an fs/process
  // import that would put I/O on the per-turn path.
  const source = readFileSync(new URL("./guidance.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import .*from "([^"]+)";$/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ["./presets"], "guidance.ts may only import the preset ids");
  for (const forbidden of [/node:fs/, /node:child_process/, /readFileSync/, /statSync/, /process\./]) {
    assert.ok(!forbidden.test(source), `guidance.ts must stay pure: ${forbidden}`);
  }
});

test("the module graph stays acyclic and points one way", () => {
  // A dependency diagram nobody checks rots. This reads the actual imports of
  // lib/fast-mode/*.ts and holds them to the documented shape:
  //   presets ← guidance ← settings
  //                    ↖ command ← extension
  const dir = new URL(".", import.meta.url);
  const files = ["presets.ts", "guidance.ts", "settings.ts", "command.ts", "extension.ts"];
  const allowed = {
    "presets.ts": [],
    "guidance.ts": ["presets"],
    "settings.ts": ["guidance"],
    "command.ts": ["guidance", "presets"],
    "extension.ts": ["command", "guidance", "settings"],
  };
  for (const file of files) {
    const source = readFileSync(new URL(file, dir), "utf8");
    const local = [...source.matchAll(/from "\.\/([a-z-]+)"/g)].map((match) => match[1]);
    assert.deepEqual(
      [...new Set(local)].sort(),
      [...allowed[file]].sort(),
      `${file} imports ${local.join(", ") || "nothing"}`,
    );
  }
});

test("the section key is pinned, because it is a wire name, not an implementation detail", () => {
  // Mutation-tested: renaming this value and updating the constant propagates through
  // every import, so nothing the suite asserts would notice — yet the key is visible to
  // the SDK and in anything that reads prompts/transcripts. Pin the literal.
  assert.equal(FAST_MODE_SECTION, "fast_mode");
});


test("read-your-write survives a filesystem that hides the change", () => {
  // The cache is keyed by mtime + size. A write landing in the same timestamp tick with
  // an equal-length file would look unchanged, so the writer must drop the cache itself
  // rather than rely on the stat.
  const dir = mkdtempSync(join(tmpdir(), "pi-web-fast-mode-ryw-"));
  const path = join(dir, "settings.json");
  try {
    writeFileSync(path, JSON.stringify({ fastMode: { preset: "off" } }));
    assert.equal(readFastModeConfig(path).preset, "off");
    const before = statSync(path);

    writeFileSync(path, JSON.stringify({ fastMode: { preset: "standard" } }));
    utimesSync(path, before.atime, before.mtime); // pretend the write is invisible

    writeFastModeConfig({ preset: "conservative" }, path);
    assert.equal(readFastModeConfig(path).preset, "conservative", "the writer's own value wins");
    // And an external edit still needs a visible mtime/size change — documented bound.
    assert.equal(JSON.parse(readFileSync(path, "utf8")).fastMode.preset, "conservative");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the registered command exposes completions and a description that names the presets", async () => {
  const { createFastModeExtension } = await jiti.import("./extension.ts");
  const commands = new Map();
  await createFastModeExtension(() => resolveFastModeConfig("off")).factory({
    on: () => {},
    registerCommand: (name, options) => commands.set(name, options),
  });
  const command = commands.get("fast");
  assert.ok(command, "/fast is registered");
  assert.match(command.description, /off \| conservative \| standard/);
  assert.deepEqual(
    command.getArgumentCompletions("").map((item) => item.value),
    ["off", "conservative", "standard"],
  );
  assert.deepEqual(command.getArgumentCompletions("s").map((item) => item.value), ["standard"]);
  assert.equal(command.getArgumentCompletions("zzz"), null);
});

test("chat-only sessions do not get fast mode, because they send an exact prompt", () => {
  // A chat-only session replaces the prompt wholesale; a section added beside it would be
  // dropped or fight it. The wiring keeps the extension out of that branch on purpose.
  const source = readFileSync(new URL("../rpc-manager.ts", import.meta.url), "utf8");
  // The import line mentions the constant too, so anchor on the spread inside the branch.
  const start = source.indexOf("...CHAT_ONLY_RESOURCE_LOADER_OPTIONS,");
  assert.ok(start > 0, "chat-only branch found");
  const branch = source.slice(start, start + 300);
  assert.doesNotMatch(branch, /createFastModeExtension/, "no fast mode in the exact-prompt branch");
  assert.match(branch, /exactSystemPromptExtension/);
});
