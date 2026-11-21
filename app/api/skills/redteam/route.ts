import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  installRedteamPack,
  redteamPackStatus,
  uninstallRedteamPack,
} from "@/lib/redteam-skills";

export const dynamic = "force-dynamic";

/** GET /api/skills/redteam — 包是否随应用提供 + 已安装多少。 */
export async function GET() {
  try {
    return NextResponse.json({ status: redteamPackStatus() });
  } catch (error) {
    console.warn("[skills/redteam] status failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not read the skill pack" }, { status: 500 });
  }
}

/**
 * POST /api/skills/redteam  body: { action: "install" | "uninstall" }
 *
 * 安装 = 把随应用打包的 23 个 SKILL.md 复制到 `<agent dir>/skills/redteam/`；
 * 移除 = 只删安装标记记录过的目录。两边都返回最新状态，面板一次请求即可刷新。
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let action: unknown;
  try {
    ({ action } = (await req.json()) as { action?: unknown });
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    if (action === "install") {
      const result = installRedteamPack();
      return NextResponse.json({ result, status: redteamPackStatus() });
    }
    if (action === "uninstall") {
      const result = uninstallRedteamPack();
      if (!result.removed && result.reason === "not-a-pack") {
        // Deliberately no path in the response: it can carry the user's home directory.
        return NextResponse.json({ error: "The redteam skills directory was not installed by this app" }, { status: 409 });
      }
      return NextResponse.json({ result, status: redteamPackStatus() });
    }
    return NextResponse.json({ error: 'action must be "install" or "uninstall"' }, { status: 400 });
  } catch (error) {
    // Never echo the underlying error: it can contain a filesystem path.
    console.warn("[skills/redteam] action failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "The skill pack operation failed" }, { status: 500 });
  }
}
