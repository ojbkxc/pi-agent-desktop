import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * 本机默认模型：读一次 `~/.pi/agent/settings.json` 的 `defaultModel`。
 *
 * 住在 `lib/` 而不是路由里，是因为 route.ts 只能导出 Next 的约定名（`scripts/route-exports.test.mjs`）：
 * 多一个具名导出，`.next/types` 的 `OmitWithTag<typeof import(...)>` 就会报 TS2344、
 * `npm run build` 直接红，而 `tsc --noEmit` 看不见（它跑在 `.next/types` 生成之前）。
 */

export interface DefaultModel {
  provider: string;
  modelId: string;
}

/**
 * The default model this machine's settings name, or null.
 *
 * Deliberately one small file read: no model registry, no extension loading, no
 * `resolveVisibleModels()`. The only caller is the purge console opening, and it
 * must never end up on a request path — a per-generation settings read would be
 * a real cost for a badge.
 *
 * Absent, unparsable or half-written all answer null: a badge is not worth an
 * error, and guessing a model here would put a wrong label on the library.
 */
export function readDefaultModel(agentDir = getAgentDir()): DefaultModel | null {
  let text: string;
  try {
    text = readFileSync(join(agentDir, "settings.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    // A byte-order mark is allowed, as SettingsManager allows it.
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const model = (parsed as { defaultModel?: unknown }).defaultModel;
  if (typeof model !== "object" || model === null) return null;
  const { provider, modelId } = model as { provider?: unknown; modelId?: unknown };
  if (typeof provider !== "string" || typeof modelId !== "string") return null;
  if (provider === "" || modelId === "") return null;
  return { provider, modelId };
}

/**
 * 只读：本机的默认模型标识。
 *
 * 只用于让预设库标出「哪条预设是写给这个模型的」。它不应用任何预设、不写设置、
 * 不参与判定 —— 自动套用由 `auto_preset` 开关在请求路径上决定，与这个只读接口无关。
 */
export function activeModelPayload(agentDir?: string) {
  return { model: readDefaultModel(agentDir)?.modelId ?? null };
}