import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  isMemoryValidationError,
  type MemoryEntry,
  type MemoryStore,
} from "@/lib/memory/store";

/**
 * 长期记忆 REST 接口的共享形状（与本仓 fork 路由一致：错误体 `{ error }`，输入校验错误
 * 额外带 `code: "validation"`，见 app/api/scheduled-tasks/api.ts、app/api/autofix）。
 */

/** 写请求守卫：来源不可信 → 403，非 JSON → 415；返回要直接发送的响应或 null。 */
export function rejectUnsafeMemoryWrite(req: Request): NextResponse | null {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  return null;
}

/** 校验错误 → 400（`code: "validation"`）；其余 → 500。 */
export function memoryErrorResponse(error: unknown): NextResponse {
  if (isMemoryValidationError(error)) {
    return NextResponse.json({ error: error.message, code: "validation" }, { status: 400 });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}

/** 记忆列表响应：`{ entries }`（按 updatedAt 倒序，最近更新的在前）。 */
export function listMemoryEntries(store: MemoryStore): { entries: MemoryEntry[] } {
  const entries = [...store.list()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
  return { entries };
}