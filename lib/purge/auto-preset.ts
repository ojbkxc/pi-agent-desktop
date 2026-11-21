import { BUILTIN_PRESETS } from "./preset-catalog";
import { resolveAutoPreset } from "./auto-apply";
import { readDefaultModel } from "./active-model";
import { readPurgeSettings } from "../purge-settings";

/**
 * 只读：这台机器当前的「自动套用」会挑中哪一条预设。
 *
 * 住在 `lib/` 而不是路由里，是因为 route.ts 只能导出 Next 的约定名
 * （`scripts/route-exports.test.mjs`）。这是面板的一行提示，不是执行路径 ——
 * 真正的套用发生在 `lib/purge/extension.ts` 的 `before_agent_start` 里，用会话
 * 自己的模型标识；这里用本机默认模型回答，因为面板在会话之外，没有「当前会话」可问。
 */
export function autoPresetPayload(
  settings = readPurgeSettings(),
  model = readDefaultModel()?.modelId ?? null,
) {
  const hit = resolveAutoPreset(BUILTIN_PRESETS, settings, model ?? "");
  return {
    /** 本机默认模型；读不到就是 null。 */
    model: model ?? null,
    /** 总开关与自动套用开关都开着，才会真的套。 */
    active: settings.enabled === true && settings.auto_preset === true,
    mode: settings.auto_preset_mode,
    match: settings.auto_preset_match,
    pinned: settings.auto_preset_id !== "" ? settings.auto_preset_id : null,
    preset: hit
      ? {
        id: hit.preset.id,
        title: hit.preset.title,
        vendor: hit.preset.vendor,
        model: hit.preset.model,
        match: hit.match,
      }
      : null,
  };
}