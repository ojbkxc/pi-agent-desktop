import { NextResponse } from "next/server";
import { readGoalState } from "@/lib/goal/goal-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/goals/[session] —— 目标进度条的数据源（**纯只读**）。
 *
 * 返回 `{ goal: GoalState | null }`：该会话没有目标（或目标 JSON 解析失败）时为 `null`，
 * 界面据此不渲染进度条。这里绝不写盘——目标的真源在扩展（内存 + 会话文件），
 * pause / resume / clear 只能**投递给会话**由扩展处理，见文件末尾的 POST 说明。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ session: string }> },
) {
  const { session } = await params;
  try {
    const goal = readGoalState(decodeURIComponent(session));
    return NextResponse.json({ goal }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { goal: null, error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

// 刻意只有 GET：cc-haha 的 `ActiveGoalStrip` 是纯展示条，暂停 / 继续 / 清除都走会话里的
// `/goal` 命令，没有单独的写接口。目标状态的唯一真源在 `createGoalExtension` 的内存与会话
// 文件里，桌面若自己写盘就会与扩展的状态机分叉（与计划卡 approve 同一教训）。
