import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed, readJsonBody } from "@/lib/request-security";
import { normalizePurgeSettings, readPurgeSettings } from "@/lib/purge-settings";
import { readDefaultModel } from "@/lib/purge/active-model";
import {
  PURGE_PREVIEW_MAX_CHARS,
  asPurgePreviewKind,
  previewGovernance,
} from "@/lib/purge/preview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * 只读试跑：把一段样例文本按「草稿设置」过一遍，返回改写前后。
 *
 * 为什么 POST 而不是 GET：要带一段可能上千字的样例文本，塞进 query 会被各层
 * 长度限制截断；POST 只表示「送一段文本进来算一次」，服务端**不写任何东西**
 * （不落盘、不改设置），所以它仍然是一个只读端点——闸门却按写路由配齐：
 * 来源守卫 → 415 → 400(JSON) → 400(字段)。
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;

  const body = read.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.text !== "string") {
    return NextResponse.json({ error: "text must be a string" }, { status: 400 });
  }
  if (raw.text.length > PURGE_PREVIEW_MAX_CHARS) {
    return NextResponse.json(
      { error: `text is limited to ${PURGE_PREVIEW_MAX_CHARS} characters` },
      { status: 400 },
    );
  }

  // 草稿优���：面板在「还没保存」时也要能试跑，否则用户必须先保存（全局生效）
  // 才能看到效果，那正是这个功能要避免的。草稿仍按白名单归一化，未知键丢弃。
  const draft = raw.settings === undefined
    ? readPurgeSettings()
    : normalizePurgeSettings(raw.settings);

  const result = previewGovernance({
    text: raw.text,
    kind: asPurgePreviewKind(raw.kind),
    settings: draft,
    model: typeof raw.model === "string" ? raw.model : readDefaultModel()?.modelId ?? "",
  });
  return NextResponse.json({ preview: result }, { headers: NO_STORE });
}