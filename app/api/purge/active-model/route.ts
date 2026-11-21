import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

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
 * 不参与判定 —— 人工点击应用依旧是唯一入口。
 */
export function activeModelPayload(agentDir?: string) {
  return { model: readDefaultModel(agentDir)?.modelId ?? null };
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return NextResponse.json(activeModelPayload(), { headers: NO_STORE });
}
