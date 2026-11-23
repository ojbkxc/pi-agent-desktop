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
const { BUILTIN_PRESETS } = await jiti.import("./preset-catalog.ts");
const { resolveAutoPreset } = await jiti.import("./auto-apply.ts");

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

function boot(fake, readSettings, readModel) {
  const extension = createPurgeExtension({ readSettings, ...(readModel ? { readModel } : {}) });
  assert.equal(extension.name, PURGE_EXTENSION_NAME);
  assert.equal(extension.hidden, true);
  extension.factory(fake.pi);
  return fake;
}

function bootWith(fake, cfg, readModel) {
  return boot(fake, () => cfg, readModel);
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
    // 总闸默认是打开的，所以「关闭」必须显式写出来。
    enabled: false,
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
  bootWith(off, { ...defaultPurgeSettings(), enabled: false });
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

test("a clamped level is restored when the run ends, so the switch off is a real passthrough", () => {
  const fake = fakePi("high");
  bootWith(fake, settings({ reduce_reasoning: true, reasoning_floor: "low" }));
  fake.handlers.get("before_agent_start")(beforeAgentStart("prompt"));
  assert.deepEqual(fake.state.setLevels, ["low"], "the run starts clamped");

  // 会话级 setThinkingLevel 不还原，控制台关了之后会话还留在 low 上。
  fake.handlers.get("agent_end")({ type: "agent_end", messages: [] });
  assert.deepEqual(fake.state.setLevels, ["low", "high"], "the pre-clamp level comes back");
  assert.equal(fake.state.level, "high");
});

test("one run clamps and restores once, even with several before_agent_start calls", () => {
  const fake = fakePi("xhigh");
  bootWith(fake, settings({ reduce_reasoning: true, reasoning_floor: "medium" }));
  fake.handlers.get("before_agent_start")(beforeAgentStart("a"));
  fake.handlers.get("before_agent_start")(beforeAgentStart("b"));
  fake.handlers.get("agent_end")({ type: "agent_end", messages: [] });
  // 第二次调用的「现档位」已经是 medium，不需要再压；还原只还到最初那个 xhigh。
  assert.deepEqual(fake.state.setLevels, ["medium", "xhigh"]);
});

test("a level the operator changed mid-run is left alone at agent_end", () => {
  const fake = fakePi("high");
  bootWith(fake, settings({ reduce_reasoning: true, reasoning_floor: "low" }));
  fake.handlers.get("before_agent_start")(beforeAgentStart("prompt"));
  // 用户在跑的过程中自己把档位调到了 xhigh：那是他的选择，还原会把它改回去。
  fake.pi.setThinkingLevel("xhigh");
  fake.handlers.get("agent_end")({ type: "agent_end", messages: [] });
  assert.deepEqual(fake.state.setLevels, ["low", "xhigh"], "no restore after an operator change");
  assert.equal(fake.state.level, "xhigh");
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
  // 从「显式关闭」开始，保存后变开启：证明每次事件都重读，而不是缓存了构造时的快照。
  let current = { ...defaultPurgeSettings(), enabled: false };
  boot(fake, () => current);

  assert.equal(fake.handlers.get("before_agent_start")(beforeAgentStart("HACK")), undefined);

  current = settings({ dead_zone_rewrite: true, rewrite_rules: [{ from: "hack", to: "audit" }] });
  assert.deepEqual(
    fake.handlers.get("before_agent_start")(beforeAgentStart("HACK")),
    { systemPrompt: "audit" },
  );
});

/** 目录里写给这个模型的那条预设 —— 自动套用的期望值，不在测试里硬编码正文。 */
function presetFor(model, overrides = {}) {
  const hit = resolveAutoPreset(BUILTIN_PRESETS, settings({ auto_preset: true, ...overrides }), model);
  assert.ok(hit, `${model} 应当有可套用的预设`);
  return hit.preset;
}

test("auto preset puts the model's own preset in front of the system prompt, verbatim", () => {
  const model = "deepseek-v4";
  const preset = presetFor(model);
  const fake = fakePi();
  bootWith(fake, settings({ auto_preset: true }), () => model);

  const before = purgeStatsSnapshot();
  const result = fake.handlers.get("before_agent_start")(beforeAgentStart("HOST"));
  assert.deepEqual(result, { systemPrompt: `${preset.body}\n\nHOST` });
  assert.equal(purgeStatsSnapshot().auto_preset_hits - before.auto_preset_hits, 1);
});

test("auto preset can append instead, and never doubles up", () => {
  const model = "deepseek-v4";
  const preset = presetFor(model);
  const fake = fakePi();
  bootWith(fake, settings({ auto_preset: true, auto_preset_mode: "append" }), () => model);

  const result = fake.handlers.get("before_agent_start")(beforeAgentStart("HOST"));
  assert.equal(result.systemPrompt, `HOST\n\n${preset.body}`);
  // 宿主提示词里已经带着这段正文时，不再拼第二遍（同一轮的后续请求）。
  const again = fake.handlers.get("before_agent_start")(beforeAgentStart(result.systemPrompt));
  assert.equal(again.systemPrompt, result.systemPrompt);
});

test("auto preset stays off unless the switch says otherwise, and never guesses", () => {
  const off = fakePi();
  bootWith(off, settings({ auto_preset: false }), () => "deepseek-v4");
  assert.deepEqual(off.handlers.get("before_agent_start")(beforeAgentStart("HOST")), { systemPrompt: "HOST" });

  // 打开但拿不到模型标识：不查、不套。
  const noModel = fakePi();
  bootWith(noModel, settings({ auto_preset: true }), () => undefined);
  assert.deepEqual(noModel.handlers.get("before_agent_start")(beforeAgentStart("HOST")), { systemPrompt: "HOST" });

  // exact 模式下没有同名预设就是没有：不拿别的模型顶替。
  const exactMiss = fakePi();
  bootWith(exactMiss, settings({ auto_preset: true }), () => "zzz-unknown-model-9");
  assert.deepEqual(exactMiss.handlers.get("before_agent_start")(beforeAgentStart("HOST")), { systemPrompt: "HOST" });
});

test("vendor fallback happens only when the operator opted in", () => {
  const model = "deepseek-v9-ultra";
  assert.equal(resolveAutoPreset(BUILTIN_PRESETS, settings({ auto_preset: true }), model), undefined);

  const vendorHit = resolveAutoPreset(
    BUILTIN_PRESETS,
    settings({ auto_preset: true, auto_preset_match: "vendor" }),
    model,
  );
  assert.equal(vendorHit?.match, "vendor");

  const fake = fakePi();
  bootWith(fake, settings({ auto_preset: true, auto_preset_match: "vendor" }), () => model);
  const result = fake.handlers.get("before_agent_start")(beforeAgentStart("HOST"));
  assert.equal(result.systemPrompt, `${vendorHit.preset.body}\n\nHOST`);
});

test("a pinned preset id wins over model matching, and a dead id applies nothing", () => {
  const pinned = BUILTIN_PRESETS[0];
  const fake = fakePi();
  // 固定 id 不依赖模型：这里连模型都不给。
  bootWith(fake, settings({ auto_preset: true, auto_preset_id: pinned.id }), () => "");
  assert.deepEqual(
    fake.handlers.get("before_agent_start")(beforeAgentStart("HOST")),
    { systemPrompt: `${pinned.body}\n\nHOST` },
  );

  const dead = fakePi();
  bootWith(dead, settings({ auto_preset: true, auto_preset_id: "no-such-preset" }), () => "deepseek-v4");
  assert.deepEqual(dead.handlers.get("before_agent_start")(beforeAgentStart("HOST")), { systemPrompt: "HOST" });
});

test("the preset body is never rewritten by the governance rules", () => {
  const model = "deepseek-v4";
  const preset = presetFor(model);
  const word = preset.body.trim().split(/\s+/)[0];
  assert.ok(word.length > 0);

  const fake = fakePi();
  bootWith(
    fake,
    settings({ auto_preset: true, dead_zone_rewrite: true, rewrite_rules: [{ from: word, to: "REWRITTEN" }] }),
    () => model,
  );
  const result = fake.handlers.get("before_agent_start")(beforeAgentStart("HOST"));
  // 词表只作用在宿主提示词上：预设正文原样出现，一个字都不改。
  assert.ok(result.systemPrompt.includes(preset.body), "预设正文被词表改写了");
  assert.equal(result.systemPrompt, `${preset.body}\n\nHOST`);
});
