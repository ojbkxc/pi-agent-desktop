import { existsSync, statSync } from "node:fs";
import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { detectVerifyCommand } from "@/lib/autofix/detect";
import { createAutofixTask, listAutofixTasks } from "@/lib/autofix/store";
import { emitAutofixEvent } from "@/lib/autofix/events";
import { startAutofixTask, summarizeAutofixTasks } from "@/lib/autofix/runner";
import { isAutofixValidationError } from "@/lib/autofix/types";
export const dynamic = "force-dynamic";

function rejectUnsafeWrite(req: Request): NextResponse | null {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  return null;
}

function errorResponse(error: unknown): NextResponse {
  if (isAutofixValidationError(error)) {
    return NextResponse.json({
      error: error.message,
      code: "validation",
      ...(error.key ? { key: error.key } : {}),
      ...(error.params ? { params: error.params } : {}),
    }, { status: 400 });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}

// GET /api/autofix —— 任务列表 + 汇总（列表页 / 挂机保活的状态展示）。
export async function GET() {
  try {
    const tasks = listAutofixTasks();
    const summary = await summarizeAutofixTasks();
    return NextResponse.json({ tasks, summary });
  } catch (error) {
    return errorResponse(error);
  }
}

// POST /api/autofix —— 建任务并立刻开始修（后台驱动，立即返回）。
// body: { task: string; cwd: string; verifyCommand?: string; maxRounds?: number }
export async function POST(req: Request) {
  const rejected = rejectUnsafeWrite(req);
  if (rejected) return rejected;
  try {
    const body: unknown = await req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
    }
    const input = body as { task?: unknown; cwd?: unknown; verifyCommand?: unknown; maxRounds?: unknown };
    const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
    if (cwd) {
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        return NextResponse.json({
          error: `Directory does not exist: ${cwd}`,
          code: "validation",
          key: "autofix.error.cwdMissing",
          params: { path: cwd },
        }, { status: 400 });
      }
    }
    const explicitVerify = typeof input.verifyCommand === "string" ? input.verifyCommand.trim() : "";
    const verifyCommand = explicitVerify || (cwd ? detectVerifyCommand(cwd) ?? "" : "");
    const maxRounds = input.maxRounds === undefined
      ? undefined
      : typeof input.maxRounds === "number"
        ? input.maxRounds
        : Number(input.maxRounds);
    const created = createAutofixTask({
      task: typeof input.task === "string" ? input.task : "",
      cwd,
      verifyCommand,
      ...(maxRounds === undefined || Number.isNaN(maxRounds) ? {} : { maxRounds }),
    });
    emitAutofixEvent({ type: "task_changed", taskId: created.id, status: created.status });
    // PI_WEB_DISABLE_AUTOFIX_DRIVER=1 时 startAutofixTask 自己就是 no-op（测试/e2e 缝）。
    void startAutofixTask(created.id);
    return NextResponse.json({ task: created }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
