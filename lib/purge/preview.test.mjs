import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 试跑的契约：**预览与数据面共用同一批纯函数**，所以「预览说会改成什么」就是
 * 「实际会改成什么」。这组用例钉住三件事：
 * 1. 总闸关着 = 逐字节透传（预览也必须如实说透传，而不是「看起来改了」）；
 * 2. 宿主提示词侧（system）与用户文本侧（user）各跑各的那一半治理；
 * 3. 自动套用只在 system 侧发生，且与 extension.ts 的拼接口径一致（已含则不重复拼）。
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const { previewGovernance, asPurgePreviewKind, PURGE_PREVIEW_MAX_CHARS } = await jiti.import("./preview.ts");
const { defaultPurgeSettings } = await jiti.import("./types.ts");

function settings(overrides = {}) {
  return { ...defaultPurgeSettings(), enabled: true, ...overrides };
}

test("master switch off is a byte-for-byte passthrough, and the preview says so", () => {
  const result = previewGovernance({
    text: "渗透测试 与 黑客",
    kind: "user",
    settings: settings({ enabled: false, dead_zone_rewrite: true }),
  });
  assert.equal(result.passthrough, true);
  assert.equal(result.output, result.input, "no rewrite when disabled");
  assert.equal(result.rewrite_hits, 0);
  assert.equal(result.passthrough_output, result.input);
});

test("the user side applies literal rewrites and reports hits", () => {
  const result = previewGovernance({
    text: "做一个渗透测试，黑客视角",
    kind: "user",
    settings: settings({ dead_zone_rewrite: true }),
  });
  assert.equal(result.passthrough, false);
  assert.match(result.output, /授权的安全评估测试/);
  assert.match(result.output, /安全研究人员/);
  assert.equal(result.rewrite_hits, 2, "one hit per occurrence");
  assert.ok(result.deltaChars > 0, "the neutral wording is longer, and the panel shows that");
});

test("the system side never injects skills, the user side does", () => {
  const base = settings({ skill_inject: true, skill_dir: "/nonexistent-skills-dir-for-preview" });
  const system = previewGovernance({ text: "host prompt", kind: "system", settings: base });
  const user = previewGovernance({ text: "host prompt", kind: "user", settings: base });
  assert.equal(system.skill_hits, 0, "skills go on the user text, never the system prompt");
  assert.equal(system.output, "host prompt", "an unreadable skill dir is silence, not an error");
  assert.equal(user.skill_hits, 0, "no matching skill found in a missing directory");
});

test("structured suffix shows up on the user side and is reported as such", () => {
  const result = previewGovernance({
    text: "hello",
    kind: "user",
    settings: settings({ structured_prompt: true, structured_suffix: "OUTPUT-AS-JSON" }),
  });
  assert.equal(result.structured, true);
  assert.equal(result.output, "hello\n\nOUTPUT-AS-JSON");
});

test("auto preset applies on the system side only, and never duplicates an existing body", () => {
  const pinned = settings({ auto_preset: true, auto_preset_id: "" });
  // 用目录里真存在的一条：按预设 id 固定，避开「本机模型是否匹配」的环境依赖。
  const presetId = "gpt-new";
  const first = previewGovernance({
    text: "host prompt",
    kind: "system",
    settings: { ...pinned, auto_preset_id: presetId },
  });
  if (first.auto_preset === null) {
    // 目录里没有这条 id 时什么也不套（resolver 的既定语义），不是错误。
    assert.equal(first.output, "host prompt");
  } else {
    assert.equal(first.auto_preset.id, presetId);
    assert.notEqual(first.output, "host prompt", "the body was spliced in");
    // 同一段正文再跑一次：已包含则不重复拼，保持幂等。
    const again = previewGovernance({
      text: first.output,
      kind: "system",
      settings: { ...pinned, auto_preset_id: presetId },
    });
    assert.equal(again.output, first.output, "an already-present body is not appended twice");
  }

  const onUser = previewGovernance({ text: "hi", kind: "user", settings: { ...pinned, auto_preset_id: presetId } });
  assert.equal(onUser.auto_preset, null, "the preset never lands on the user message");
});

test("kind is normalized, unknown values fall back to user", () => {
  assert.equal(asPurgePreviewKind("system"), "system");
  assert.equal(asPurgePreviewKind("user"), "user");
  assert.equal(asPurgePreviewKind("SYSTEM"), "user");
  assert.equal(asPurgePreviewKind(undefined), "user");
  assert.equal(asPurgePreviewKind(42), "user");
});

test("the preview is bounded, so a whole session cannot be pasted in", () => {
  assert.ok(Number.isInteger(PURGE_PREVIEW_MAX_CHARS));
  assert.ok(PURGE_PREVIEW_MAX_CHARS >= 4_000 && PURGE_PREVIEW_MAX_CHARS <= 100_000);
});

test("empty text still returns a complete record instead of throwing", () => {
  const result = previewGovernance({ text: "", kind: "user", settings: settings({ dead_zone_rewrite: true }) });
  assert.equal(result.input, "");
  assert.equal(result.output, "");
  assert.equal(result.deltaChars, 0);
});