import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { emitAutofixEvent } from "@/lib/autofix/events";
import { deleteAutofixTask, getAutofixTask } from "@/lib/autofix/store";
import { resumeAutofixTask, stopAutofixTask } from "@/lib/autofix/runner";
import { isActiveAutofixStatus, isAutofixValidationError } from "@/lib/autofix/types";

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
    return NextResponse.json({ error: error.message, code: "validation" }, { status: 400 });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}

// GET /api/autofix/[id] —— 单任务（含轮次时间线）。
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const task = getAutofixTask(id);
    if (!task) return NextResponse.json({ error: "Task not found", code: "not_found" }, { status: 404 });
    return NextResponse.json({ task });
  } catch (error) {
    return errorResponse(error);
  }
}

// POST /api/autofix/[id] —— { action: "stop" | "resume" }。
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const rejected = rejectUnsafeWrite(req);
  if (rejected) return rejected;
  const { id } = await params;
  try {
    const body = await req.json().catch(() => ({})) as { action?: unknown };
    const action = typeof body.action === "string" ? body.action : "";
    const task = getAutofixTask(id);
    if (!task) return NextResponse.json({ error: "Task not found", code: "not_found" }, { status: 404 });
    if (action === "stop") {
      if (task.status === "succeeded") {
        return NextResponse.json({ error: "This task already succeeded", code: "validation" }, { status: 409 });
      }
      const stopped = await stopAutofixTask(id);
      return NextResponse.json({ task: stopped ?? task });
    }
    if (action === "resume") {
      if (isActiveAutofixStatus(task.status)) {
        return NextResponse.json({ error: "This task is already active", code: "validation" }, { status: 409 });
      }
      const resumed = await resumeAutofixTask(id);
      return NextResponse.json({ task: resumed ?? task });
    }
    return NextResponse.json({ error: "Unknown action", code: "validation" }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}

// DELETE /api/autofix/[id] —— 先停止（在跑时），再删记录。
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await params;
  try {
    const task = getAutofixTask(id);
    if (!task) return NextResponse.json({ error: "Task not found", code: "not_found" }, { status: 404 });
    if (isActiveAutofixStatus(task.status)) await stopAutofixTask(id);
    const removed = deleteAutofixTask(id);
    if (removed) emitAutofixEvent({ type: "task_removed", taskId: id });
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error);
  }
}
