/**
 * 「模型 → 预设」的**查询**层：给定当前模型标识，返回候选预设及其匹配强度。
 *
 * 这里只回答「哪个预设是写给这个模型的」，**不做任何动作**：不应用预设、不写设置、
 * 不改发出去的请求。动作在 `auto-apply.ts`：它先过 `settings.auto_preset` 开关，
 * 才把命中的正文拼进系统提示词。两个模块都不碰控制面（工具审批、项目信任、沙箱），
 * 那条边界由 `governance-boundary.test.mjs` 钉住。
 *
 * 匹配规则是纯字符串比较，不读盘、不联网。
 */

/** 预设需要的最小形状：目录里带 vendor 与 model 就够。 */
export interface ModelTarget {
  readonly vendor: string;
  readonly model: string;
}

/**
 * 匹配强度。
 * - `exact`：预设的目标模型就是当前模型（允许分隔符差异）。
 * - `vendor`：模型对不上，但当前模型属于该预设的厂商。
 * - `mismatch`：两者都不成立。
 * - `unknown`：任一为空，不猜。
 */
export type PresetMatch = "exact" | "vendor" | "mismatch" | "unknown";

/**
 * 折叠大小写与分隔符：`deepseek v4` / `DeepSeek-V4` / `deepseek_v4` 是同一个模型。
 * 只做这一步，不做模糊前缀——猜错会把无关预设排到前面。
 */
export function normalizeModelId(value: string): string {
  return value.toLowerCase().replace(/[\s._\-/]+/g, "");
}

/** 给一个预设和当前模型，判定匹配强度。 */
export function presetMatchForModel(preset: ModelTarget, activeModel: string): PresetMatch {
  return presetMatchForNormalizedModel(
    normalizeModelId(preset.model),
    normalizeModelId(preset.vendor),
    normalizeModelId(activeModel),
  );
}

/**
 * 已经归一化过的入参：判定规则与 `presetMatchForModel` 是同一份。
 *
 * 存在的理由是自动套用要在一次请求里拿同一个模型比完整个目录（53 条），
 * 归一化只该做一次；两条路径共用这一份比较，规则不会分叉。
 */
export function presetMatchForNormalizedModel(
  target: string,
  vendor: string,
  active: string,
): PresetMatch {
  if (!target || !active) return "unknown";

  // 目录里有 `deepseekv4.1 and v4.1-1017` 这种一行覆盖两个模型的写法，取双向包含。
  if (active === target || active.includes(target) || target.includes(active)) return "exact";

  if (vendor && active.includes(vendor)) return "vendor";
  return "mismatch";
}

export interface ModelPresetHit<T extends ModelTarget> {
  readonly preset: T;
  readonly match: "exact" | "vendor";
}

/**
 * 当前模型可用的预设，`exact` 在前、`vendor` 在后；同组内保持目录原序
 * （目录按 (vendor, model, id) 排过，这里不再引入第二套排序）。
 *
 * 返回新数组，不修改传入的目录。
 */
export function presetsForModel<T extends ModelTarget>(
  catalog: readonly T[],
  activeModel: string,
): Array<ModelPresetHit<T>> {
  const exact: Array<ModelPresetHit<T>> = [];
  const vendor: Array<ModelPresetHit<T>> = [];
  for (const preset of catalog) {
    const match = presetMatchForModel(preset, activeModel);
    if (match === "exact") exact.push({ preset, match });
    else if (match === "vendor") vendor.push({ preset, match });
  }
  return [...exact, ...vendor];
}
