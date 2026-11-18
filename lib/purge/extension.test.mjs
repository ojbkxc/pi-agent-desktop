import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// The default settings reader must never touch the real agent dir, but point it
// somewhere harmless anyway: every test injects its own `readSettings`.
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-web-purge-ext-"));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { PURGE_EXTENSION_NAME, createPurgeExtension } = await jiti.import("./extension.ts");
const { purgeStatsSnapshot } = await jiti.import("./stats.ts");
const { defaultPurgeSettings } = await jiti.import("./types.ts");

process.env.PI_CODING_AGENT_DIR = originalAgentDir ?? "";

/** The defaults with the master switch on. */
function settings(overrides = {}) {
  return { ...defaultPurgeSettings(), enabled: true, ...overrides };
}

/** A fake `pi`: records handlers and the thinking level it was given. */
function fakePi(level = "low") {
  const handlers = new Map();
  const state = { level, setLevels: [] };
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    getThinkingLevel() {
      return state.level;
    },
    setThinkingLevel(next) {
      state.level = next;
      state.setLevels.push(next);
    },
  };
  return { pi, handlers, state };
}

function boot(fake, readSettings) {
  const extension = createPurgeExtension({ readSettings });
  assert.equal(extension.name, PURGE_EXTENSION_NAME);
  assert.equal(extension.hidden, true);
  extension.factory(fake.pi);
  return fake;
}

function bootWith(fake, cfg) {
  return boot(fake, () => cfg);
}

function beforeAgentStart(systemPrompt) {
  return {
    type: "before_agent_start",
    messageType: "user",
    prompt: "hello",
    systemPrompt,
    systemPromptOptions: { sections: {} },
  };
}

function contextEvent(messages) {
  return { type: "context", messages };
}

test("before_agent_start returns the governed system prompt when the console is on", () => {
  const fake = fakePi();
  bootWith(fake, settings({ system_normalize: true, normalize_strip_prefixes: ["[meta] "] }));

  const before = purgeStatsSnapshot();
  const result = fake.handlers.get("before_agent_start")(
    beforeAgentStart("[meta] alpha\n\n\n\nbeta  "),
  );
  assert.deepEqual(result, { systemPrompt: "alpha\n\nbeta" });

  const delta = purgeStatsSnapshot();
  assert.equal(delta.requests - before.requests, 1);
});

test("before_agent_start returns undefined when the console is off", () => {
  const fake = fakePi();
  bootWith(fake, {
    ...defaultPurgeSettings(),
    system_normalize: true,
    dead_zone_rewrite: true,
    reduce_reasoning: true,
    rewrite_rules: [{ from: "alpha", to: "beta" }],
  });

  assert.equal(fake.handlers.get("before_agent_start")(beforeAgentStart("alpha\n\n\nalpha")), undefined);
  assert.deepEqual(fake.state.setLevels, []);
});

test("context governs only the last user text and never mutates the passed array", () => {
  const fake = fakePi();
  bootWith(fake, settings({
    dead_zone_rewrite: true,
    rewrite_rules: [{ from: "hack", to: "audit" }],
    structured_prompt: true,
    structured_suffix: "先结论",
  }));

  const messages = [
    { role: "user", content: "first HACK", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 },
    {
      role: "user",
      content: [
        { type: "text", text: "do HACK please" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      timestamp: 3,
    },
  ];
  const snapshot = structuredClone(messages);

  const result = fake.handlers.get("context")(contextEvent(messages));
  assert.ok(result);
  assert.notEqual(result.messages, messages, "a new array is returned");
  assert.equal(result.messages.length, 3);
  // Untouched messages keep their identity: only the governed one is copied.
  assert.equal(result.messages[0], messages[0]);
  assert.equal(result.messages[1], messages[1]);
  assert.notEqual(result.messages[2], messages[2]);

  assert.equal(result.messages[2].content[0].text, "do audit please\n\n先结论");
  assert.equal(result.messages[2].content[1].data, "AAAA");
  assert.equal(result.messages[2].timestamp, 3);
  assert.deepStrictEqual(messages, snapshot, "the transcript is pristine");
});

test("context is idempotent across repeated provider requests in one turn", () => {
  const fake = fakePi();
  bootWith(fake, settings({ structured_prompt: true, structured_suffix: "SUFFIX" }));

  const messages = [{ role: "user", content: "question", timestamp: 1 }];
  const first = fake.handlers.get("context")(contextEvent(messages));
  const second = fake.handlers.get("context")(contextEvent(messages));

  assert.equal(first.messages[0].content, "question\n\nSUFFIX");
  assert.equal(second.messages[0].content, "question\n\nSUFFIX");
  assert.equal(messages[0].content, "question");
});

test("context returns undefined when off, when no user text exists, or when nothing changes", () => {
  const off = fakePi();
  bootWith(off, defaultPurgeSettings());
  assert.equal(
    off.handlers.get("context")(contextEvent([{ role: "user", content: "hi", timestamp: 1 }])),
    undefined,
  );

  const on = fakePi();
  bootWith(on, settings({ dead_zone_rewrite: true, rewrite_rules: [{ from: "hack", to: "audit" }] }));
  // No user text at all: only an assistant message and an image-only user turn.
  assert.equal(on.handlers.get("context")(contextEvent([
    { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 1 },
    { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 2 },
  ])), undefined);
  // A user turn whose text no rule matches needs no new array either.
  assert.equal(
    on.handlers.get("context")(contextEvent([{ role: "user", content: "clean text", timestamp: 3 }])),
    undefined,
  );
});

test("reduce_reasoning clamps only levels above the floor", () => {
  const high = fakePi("high");
  bootWith(high, settings({ reduce_reasoning: true, reasoning_floor: "low" }));
  const before = purgeStatsSnapshot();
  high.handlers.get("before_agent_start")(beforeAgentStart("prompt"));
  assert.deepEqual(high.state.setLevels, ["low"]);
  assert.equal(purgeStatsSnapshot().reasoning_clamps - before.reasoning_clamps, 1);

  // Already at or below the floor: no call, no counter.
  const atFloor = fakePi("low");
  bootWith(atFloor, settings({ reduce_reasoning: true, reasoning_floor: "low" }));
  const floorBefore = purgeStatsSnapshot();
  atFloor.handlers.get("before_agent_start")(beforeAgentStart("prompt"));
  assert.deepEqual(atFloor.state.setLevels, []);
  assert.equal(purgeStatsSnapshot().reasoning_clamps - floorBefore.reasoning_clamps, 0);

  // `off` is below `low`, so nothing to clamp either.
  const offLevel = fakePi("off");
  bootWith(offLevel, settings({ reduce_reasoning: true, reasoning_floor: "medium" }));
  offLevel.handlers.get("before_agent_start")(beforeAgentStart("prompt"));
  assert.deepEqual(offLevel.state.setLevels, []);

  // The switch itself off: the level is left alone even when it is far above.
  const switchOff = fakePi("xhigh");
  bootWith(switchOff, settings({ reduce_reasoning: false, reasoning_floor: "low" }));
  switchOff.handlers.get("before_agent_start")(beforeAgentStart("prompt"));
  assert.deepEqual(switchOff.state.setLevels, []);

  // Floor above the current level never raises it.
  const lower = fakePi("low");
  bootWith(lower, settings({ reduce_reasoning: true, reasoning_floor: "xhigh" }));
  lower.handlers.get("before_agent_start")(beforeAgentStart("prompt"));
  assert.deepEqual(lower.state.setLevels, []);
});

test("a throwing settings read degrades to the host's untouched request", () => {
  const fake = fakePi("high");
  boot(fake, () => {
    throw new Error("settings file is unreadable");
  });

  assert.equal(fake.handlers.get("before_agent_start")(beforeAgentStart("prompt")), undefined);
  assert.equal(
    fake.handlers.get("context")(contextEvent([{ role: "user", content: "hi", timestamp: 1 }])),
    undefined,
  );
  assert.deepEqual(fake.state.setLevels, []);
});

test("settings are re-read on every event, so a console save applies immediately", () => {
  const fake = fakePi();
  let current = defaultPurgeSettings();
  boot(fake, () => current);

  assert.equal(fake.handlers.get("before_agent_start")(beforeAgentStart("HACK")), undefined);

  current = settings({ dead_zone_rewrite: true, rewrite_rules: [{ from: "hack", to: "audit" }] });
  assert.deepEqual(
    fake.handlers.get("before_agent_start")(beforeAgentStart("HACK")),
    { systemPrompt: "audit" },
  );
});