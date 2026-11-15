import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { resumeAutofixTasks } from "@/lib/autofix/runner";

export const dynamic = "force-dynamic";

// POST /api/autofix/resume —— 手动触发一次接续扫描（挂机保活也走这条 HTTP 自调）。
// 幂等：没有待接续任务时返回空数组。body 可为空对象。
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (req.headers.get("content-length") !== "0" && !hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const result = await resumeAutofixTasks();
  return NextResponse.json(result);
}
