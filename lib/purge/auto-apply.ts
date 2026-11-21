/**
 * 「模型 → 预设」的**执行**层：把写给当前模型的预设正文拼进系统提示词。
 *
 * 与 `preset-match.ts`（纯查询）分工明确：
 *
 * - `preset-match.ts` 只回答「哪个预设是写给这个模型的」，不认识任何动作；
 * - 这里才动请求，而且只在 `settings.auto_preset === true` 时动。
 *
 * 三层保险，缺一不可：
 *
 * 1. 总开关 `enabled` 关着 → 直接返回 undefined，连预设库都不扫。
 * 2. `auto_preset` 关着 → 同上，行为与原实现逐字节一致。
 * 3. 匹配不上（`exact` 模式下没有同名模型）→ 返回 undefined，绝不「猜一个
 *    差不多的」塞进请求。`vendor` 兜底是操作者显式选的，不是默认。
 *
 * 预设正文**原样**参与拼接：不裁剪、不改写、不归一化。`system_normalize` /
 * 死区词改写只作用在宿主提示词上（见 `extension.ts` 的调用顺序），否则第三方
 * prompt 会被词表悄悄改写成另一份东西。
 */

import { normalizeModelId, presetMatchForNormalizedModel } from "./preset-match";
import type { PurgeAutoPresetMode, PurgeSettings } from "./types";

/** 解析预设需要的最小形状：目录里带 id / vendor / model / body 就够。 */
export interface AutoPresetTarget {
  readonly id: string;
  readonly vendor: string;
  readonly model: string;
  readonly body: string;
}

/**
 * 命中来源。
 * - `exact`：预设目标模型就是当前模型。
 * - `vendor`：`auto_preset_match === "vendor"` 时的同厂商兜底。
 * - `manual`：操作者在 `auto_preset_id` 里点名的那一条。
 */
export type AutoPresetMatchKind = "exact" | "vendor" | "manual";

export interface AutoPresetHit<T extends AutoPresetTarget> {
  readonly preset: T;
  readonly match: AutoPresetMatchKind;
}

/**
 * 每条预设归一化后的 model / vendor。
 *
 * 目录是模块常量、预设行也是常量对象，所以这份缓存与进程同寿命、不会增长；
 * 一个操作者一次会话里的几十上百个请求，每条预设的归一化只跑一次，而不是每个
 * 请求跑一遍（53 条 × 2 次正则 → 0 次）。WeakMap 的键是预设行本身，换一份目录
 * 就是另一批键，不需要失效逻辑。
 */
const normalizedKeys = new WeakMap<object, { model: string; vendor: string }>();

function keysOf(preset: AutoPresetTarget): { model: string; vendor: string } {
  const cached = normalizedKeys.get(preset);
  if (cached) return cached;
  const keys = { model: normalizeModelId(preset.model), vendor: normalizeModelId(preset.vendor) };
  normalizedKeys.set(preset, keys);
  return keys;
}

/**
 * 当前请求该套哪一条预设，没有就是 `undefined`。
 *
 * 纯函数：不读盘、不联网、不写设置，只看传进来的目录、设置快照与模型标识。
 * 候选顺序就是目录原序（生成器按 (vendor, model, id) 排过），因此同一个模型
 * 每次都会命中同一条 —— 自动套用必须是可预期的，不能今天这条明天那条。
 */
export function resolveAutoPreset<T extends AutoPresetTarget>(
  catalog: readonly T[],
  settings: PurgeSettings | undefined,
  activeModel: string | undefined,
): AutoPresetHit<T> | undefined {
  if (!settings || settings.enabled !== true || settings.auto_preset !== true) return undefined;

  const pinned = typeof settings.auto_preset_id === "string" ? settings.auto_preset_id.trim() : "";
  if (pinned !== "") {
    // 点名的那条不存在时什么也不套：拿别的预设顶替会更糟。
    const preset = catalog.find((entry) => entry.id === pinned);
    return preset ? { preset, match: "manual" } : undefined;
  }

  const model = typeof activeModel === "string" ? activeModel.trim() : "";
  if (model === "") return undefined;

  // 模型只归一化一次：目录扫描里的比较全是现成的字符串。
  const active = normalizeModelId(model);
  if (active === "") return undefined;

  for (const preset of catalog) {
    const keys = keysOf(preset);
    if (presetMatchForNormalizedModel(keys.model, keys.vendor, active) === "exact") {
      return { preset, match: "exact" };
    }
  }
  if (settings.auto_preset_match !== "vendor") return undefined;
  for (const preset of catalog) {
    const keys = keysOf(preset);
    if (presetMatchForNormalizedModel(keys.model, keys.vendor, active) === "vendor") {
      return { preset, match: "vendor" };
    }
  }
  return undefined;
}

/**
 * 把预设正文拼到宿主提示词上。
 *
 * - 正文为空（或全空白）→ 原样返回宿主提示词，不让一次空套用清掉提示词。
 * - 宿主提示词为空 → 只发正文（chat-only 会话的 `" "` 占位也走这条）。
 * - 宿主里已经有这段正文 → 不重复拼接（同一轮多次请求时保持幂等）。
 */
export function composeAutoPreset(
  hostPrompt: string,
  body: string,
  mode: PurgeAutoPresetMode,
): string {
  const preset = typeof body === "string" ? body : "";
  const host = typeof hostPrompt === "string" ? hostPrompt : "";
  if (preset.trim() === "") return host;
  if (host.includes(preset)) return host;
  if (host.trim() === "") return preset;
  return mode === "append" ? `${host}\n\n${preset}` : `${preset}\n\n${host}`;
}
