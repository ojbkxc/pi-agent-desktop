import { NextResponse } from "next/server";
import { BUILTIN_PRESETS } from "@/lib/purge/preset-catalog";
import { resolveAutoPreset } from "@/lib/purge/auto-apply";
import { readPurgeSettings } from "@/lib/purge-settings";
import { isApiRequestAllowed } from "@/lib/request-security";
import { readDefaultModel } from "../active-model/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * 只读：这台机器当前的「自动套用」会挑中哪一条预设。
 *
 * 这是面板的一行提示，不是执行路径 —— 真正的套用发生在
 * `lib/purge/extension.ts` 的 `before_agent_start` 里，用会话自己的模型标识。
 * 这里用本机默认模型回答，因为面板在会话之外，没有「当前会话」可问。
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

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return NextResponse.json(autoPresetPayload(), { headers: NO_STORE });
}
