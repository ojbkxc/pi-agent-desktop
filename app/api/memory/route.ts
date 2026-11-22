import { NextResponse } from "next/server";
import { isMemoryValidationError, createMemoryStore } from "@/lib/memory/store";
import { listMemoryEntries, memoryErrorResponse, rejectUnsafeMemoryWrite } from "@/lib/memory/api";

export const dynamic = "force-dynamic";

// GET /api/memory —— 记忆列表（设置页的列表/空态数据源）。纯只读，不校验来源。
export async function GET() {
  try {
    return NextResponse.json(listMemoryEntries(createMemoryStore()), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

// POST /api/memory —— 新增一条。body: { text: string; tags?: string[] } → `{ entry }`。
// 校验全在服务端（lib/memory/store.ts）：非空、≤4KB、条目 ≤200、标签 ≤10。
export async function POST(req: Request) {
  const rejected = rejectUnsafeMemoryWrite(req);
  if (rejected) return rejected;
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body", code: "validation" }, { status: 400 });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "Expected a JSON object", code: "validation" }, { status: 400 });
    }
    const input = body as { text?: unknown; tags?: unknown; sourceSessionId?: unknown };
    if (input.sourceSessionId !== undefined && typeof input.sourceSessionId !== "string") {
      return NextResponse.json({ error: "sourceSessionId must be a string", code: "validation" }, { status: 400 });
    }
    try {
      const entry = createMemoryStore().add({
        text: input.text,
        tags: input.tags,
        ...(typeof input.sourceSessionId === "string" ? { sourceSessionId: input.sourceSessionId } : {}),
      });
      return NextResponse.json({ entry }, { status: 201 });
    } catch (error) {
      if (isMemoryValidationError(error)) return memoryErrorResponse(error);
      throw error;
    }
  } catch (error) {
    return memoryErrorResponse(error);
  }
}