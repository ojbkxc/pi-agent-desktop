import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { createMemoryStore } from "@/lib/memory/store";
import { memoryErrorResponse, rejectUnsafeMemoryWrite } from "@/lib/memory/api";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// PATCH /api/memory/[id] —— 行内编辑。body: { text?: string; tags?: string[] } → `{ entry }`。
export async function PATCH(req: Request, { params }: Params) {
  const rejected = rejectUnsafeMemoryWrite(req);
  if (rejected) return rejected;
  const { id } = await params;
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
    const input = body as { text?: unknown; tags?: unknown };
    const entry = createMemoryStore().update(id, {
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
    });
    if (!entry) return NextResponse.json({ error: "Memory not found" }, { status: 404 });
    return NextResponse.json({ entry });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

// DELETE /api/memory/[id] —— 删除一条 → `{ success: true }`；不存在 → 404。
// 删除不要请求体，所以只校验来源，不要求 JSON Content-Type。
export async function DELETE(req: Request, { params }: Params) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await params;
  try {
    if (!createMemoryStore().remove(id)) {
      return NextResponse.json({ error: "Memory not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}