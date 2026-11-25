import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 破甲控制台「按模型自动套预设」必须选中**对的那一条**。
 *
 * 用户问的是「控制台能不能真正被用上，比如当前用 deepseek-v4.1-flash」。答案是能——扩展注册在
 * `rpc-manager`（`createPurgeExtension({ readModel: () => purgeSessionRef.current?.model?.id })`），
 * `before_agent_start` / `context` 两个钩子改写系统提示与最后一条用户消息，与具体模型无关。
 * 但**选预设**这一层原来选错了：
 *
 * 目录里的 model 键来自源文件名，写法不统一——`deepseek v4`、`deepseek-4-1`、
 * `deepseekv4.1 and v4.1-1017` 都指同一条版本线。归一化只折叠分隔符，于是
 * `deepseek-v4.1-flash` → `deepseekv41flash`，与 `deepseek41` **互不包含**，
 * 只能被目录序更靠前的泛化条目 `deepseekv4`（它的子串）命中 —— v4.1 的请求被套上 v4 的预设。
 *
 * 修法两条，缺一都会选错：
 * 1. 版本序列从**原始**串按分隔符切（`deepseek-4-1` → `["4","1"]`），归一化后再切会把
 *    `4` 与 `1` 连成 `41`，具体度分不开；
 * 2. 命中里先取「版本序列与当前模型一致」的一组，再比长度。少了这一层，那条
 *    「一行覆盖两个模型」的合并条目（版本序列 `["4","1","4","1","1017"]`）永远最长，
 *    会把 `deepseek-v4` 的请求抢走。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { BUILTIN_PRESETS } = await jiti.import("./preset-catalog.ts");
const { resolveAutoPreset } = await jiti.import("./auto-apply.ts");
const { versionSequence, sameVersion, presetMatchForModel } = await jiti.import("./preset-match.ts");

const settings = {
  enabled: true,
  auto_preset: true,
  auto_preset_mode: "prepend",
  auto_preset_match: "exact",
  auto_preset_id: "",
};
const resolve = (model) => resolveAutoPreset(BUILTIN_PRESETS, settings, model)?.preset.id ?? null;

test("version sequences are split on separators, not digit runs", () => {
  assert.deepEqual(versionSequence("deepseek v4"), ["4"]);
  assert.deepEqual(versionSequence("deepseek-4-1"), ["4", "1"], "`4-1` is two parts, not `41`");
  assert.deepEqual(versionSequence("deepseek-v4.1-flash"), ["4", "1"]);
  assert.equal(sameVersion(["4", "1"], ["4", "1"]), true);
  assert.equal(sameVersion(["4"], ["4", "1"]), false, "v4 and v4.1 are different version lines");
});

test("deepseek-v4.1-flash gets the v4.1 preset, not the generic v4 one", () => {
  assert.equal(resolve("deepseek-v4.1-flash"), "deepseek-deepseek-4-1");
  assert.equal(resolve("deepseek-v4.1"), "deepseek-deepseek-4-1");
});

test("deepseek-v4 still gets its own preset (the merged entry must not steal it)", () => {
  // `deepseekv4.1 and v4.1-1017` 的版本序列最长，只按长度排它会赢——版本一致那一层挡住它。
  assert.equal(resolve("deepseek-v4"), "deepseek-deepseek-v4");
  assert.equal(resolve("deepseek-v4-flash"), "deepseek-deepseek-v4");
});

test("the vendor line is respected: v3 stays v3", () => {
  assert.equal(resolve("deepseek-v3"), "deepseek-deepseek-v3");
  assert.equal(resolve("deepseek-v3.2"), "deepseek-deepseek-v3");
});

test("same version numbers across vendors never match", () => {
  // `claude-sonnet-4-5` 与 `deepseek-4-1` 版本序列都是 `["4","1"]` 附近，但骨架不同。
  assert.equal(presetMatchForModel({ vendor: "x", model: "deepseek-4-1" }, "claude-sonnet-4-5"), "mismatch");
  assert.equal(presetMatchForModel({ vendor: "x", model: "deepseek-4-1" }, "gpt-4-5"), "mismatch");
  assert.equal(resolve("claude-sonnet-4-5"), null);
  assert.equal(resolve("gpt-5"), null);
});

test("models the catalog has no preset for stay unmatched (no guessing)", () => {
  for (const model of ["deepseek-chat", "deepseek-reasoner", "gemini-2-5-pro", "qwen3-max", "glm-4.6"]) {
    assert.equal(resolve(model), null, `${model} must not borrow an unrelated preset`);
  }
});

test("the switch still gates everything", () => {
  const off = { ...settings, auto_preset: false };
  assert.equal(resolveAutoPreset(BUILTIN_PRESETS, off, "deepseek-v4.1-flash"), undefined);
  const disabled = { ...settings, enabled: false };
  assert.equal(resolveAutoPreset(BUILTIN_PRESETS, disabled, "deepseek-v4.1-flash"), undefined);
});
