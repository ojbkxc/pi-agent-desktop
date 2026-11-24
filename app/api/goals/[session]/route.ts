import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed, readJsonBody } from "@/lib/request-security";
import { readGoalState, writeGoalState } from "@/lib/goal/goal-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/goals/[session] —— 目标进度条的数据源（**纯只读**）。返回
 * `{ goal: GoalState | null }`：没有目标（或目标 JSON 解析失败）时为 `null`，界面据此
 * 不渲染进度条。这里绝不写盘——目标的真源在扩展，读接口只负责把它念出来。
 *
 * PATCH /api/goals/[session] —— 暂停 / 恢复一个目标。
 *
 * 为什么需要它：`paused` 这个状态一直只有扩展内部会写（用户 `/goal pause`、或撞了
 * 轮数/时间双闸），而界面上只有一个只读的进度条——想停一下只能去聊天框敲命令。
 * 这里补一个 UI 能按的开关：写的就是同一份 `GoalState`，`shouldContinueGoal` 的判据
 * 第一条就是 `status !== "active" → false`，所以「写盘即生效」，不需要扩展配合。
 *
 * 语义边界（照 `goal-store` 的口径，不另造）：
 * - 只能切 `active` ↔ `paused`；`completed` / `cleared` 是终态，不能被这个端点复活
 *   （否则一个已完成的目标会因误点按钮重新开始烧钱）。
 * - 切到 `paused` 不重置轮数与计时；切回 `active` 也不重置——双闸仍按原始 startedAt
 *   与 continuations 算，暂停不会变成「免费重置预算」。
 */

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ session: string }> },
) {
  const { session } = await params;
  return NextResponse.json({ goal: readGoalState(session) });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ session: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  const body = read.body as { status?: unknown };
  const next = body?.status;
  if (next !== "active" && next !== "paused") {
    return NextResponse.json({ error: "status must be \"active\" or \"paused\"" }, { status: 400 });
  }

  const { session } = await params;
  const current = readGoalState(session);
  if (!current) return NextResponse.json({ error: "No goal for this session" }, { status: 404 });
  if (current.status === "completed" || current.status === "cleared") {
    return NextResponse.json(
      { error: `This goal is ${current.status} and cannot be resumed from here` },
      { status: 409 },
    );
  }
  if (current.status === next) return NextResponse.json({ goal: current });

  try {
    writeGoalState({ ...current, status: next, updatedAt: Date.now() });
  } catch (error) {
    console.error(
      "[pi-web] goal status write failed:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({ error: "Could not save the goal status" }, { status: 500 });
  }
  return NextResponse.json({ goal: readGoalState(session) });
}
