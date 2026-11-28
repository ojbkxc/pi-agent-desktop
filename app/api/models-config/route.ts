import { NextResponse } from "next/server";
import { ModelsConfigReadError, readModelsConfig, writeModelsConfig } from "@/lib/models-config-store";
import { mergeStoredLiteralApiKeys, redactModelsJson } from "@/lib/models-config-redaction";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { ContextWindowError, normalizeContextWindowOverrides } from "@/lib/model-context";
import { checkProviderEntries, ProviderEntryError } from "@/lib/model-provider-check";
import { checkImageMaxBytes, ImageMaxBytesError } from "@/lib/model-image-limits";

export const dynamic = "force-dynamic";

/**
 * 错误收敛（数据/测试审计 A-8）：`ModelsConfigReadError.message` 带绝对路径
 * （`Failed to read /home/.../models.json: ...`），不能原样回给客户端——隧道暴露后
 * 会把用户目录结构泄露给任何访问者。原始文本只进服务端日志，响应只给稳定 code。
 */
function readErrorResponse(status: number) {
  return NextResponse.json(
    { error: "The models configuration could not be read.", code: "models-config-unreadable" },
    { status },
  );
}

export async function GET() {
  try {
    // Literal apiKey values never leave the server; shell/env references and
    // every other field are configuration the editor needs to see.
    return NextResponse.json(redactModelsJson(readModelsConfig()));
  } catch (error) {
    if (error instanceof ModelsConfigReadError) {
      console.error(`[models-config] ${error.message}`);
      return readErrorResponse(422);
    }
    return NextResponse.json({ error: "Could not read the models configuration.", code: "models-config-read-failed" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json() as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const existing = readModelsConfig();
    const incomingProviders = (body.providers ?? {}) as Record<string, Record<string, unknown>>;
    const existingProviders = (existing.providers ?? {}) as Record<string, Record<string, unknown>>;
    // The client never sees stored literal apiKeys (GET redacts them), so an
    // incoming provider that omits the field must keep the stored value while
    // the user edits unrelated settings. An explicit apiKey (even "") wins.
    // Context-window overrides are checked and normalized as upstream does (Settings › Models).
    const config = normalizeContextWindowOverrides({
      ...body,
      providers: mergeStoredLiteralApiKeys(incomingProviders, existingProviders),
    });
    checkProviderEntries(config);
    checkImageMaxBytes(config);
    writeModelsConfig(config);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ContextWindowError || error instanceof ProviderEntryError || error instanceof ImageMaxBytesError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ModelsConfigReadError) {
      console.error(`[models-config] ${error.message}`);
      return readErrorResponse(409);
    }
    return NextResponse.json({ error: "Could not save the models configuration.", code: "models-config-write-failed" }, { status: 500 });
  }
}
