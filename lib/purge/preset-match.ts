/**
 * 「模型 → 预设」的**查询**层：给定当前模型标识，返回候选预设及其匹配强度。
 *
 * 这里只回答「哪个预设是写给这个模型的」，**不做任何动作**：不应用预设、不写设置、
 * 不改发出去的请求。存在的理由是让面板能把「当前模型可用的预设」排到前面，而不是
 * 让宿主在用户选完模型后静默套上破甲文本 —— 后者需要用户明确点击，永远不由模型
 * 标识自动触发。
 *
 * 因此本模块**不得**被 `before_agent_start` 或 `context` 引用；`governance-boundary.test.mjs`
 * 会把这条单向边界钉住。匹配规则是纯字符串比较，不读盘、不联网。
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
  const target = normalizeModelId(preset.model);
  const active = normalizeModelId(activeModel);
  if (!target || !active) return "unknown";

  // 目录里有 `deepseekv4.1 and v4.1-1017` 这种一行覆盖两个模型的写法，取双向包含。
  if (active === target || active.includes(target) || target.includes(active)) return "exact";

  const vendor = normalizeModelId(preset.vendor);
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
