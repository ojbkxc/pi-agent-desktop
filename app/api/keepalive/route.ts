import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { buildKeepaliveStatus, supervisorScriptPath } from "@/lib/keepalive/status";
import { clearKeepaliveStopMarker, writeKeepaliveSettings } from "@/lib/keepalive/store";
import { isLocalRequest } from "@/lib/remote-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const execFileAsync = promisify(execFile);

/** 主开关之外，允许界面触发守护脚本的四个动作（start 清停止标记并拉起）。 */
const ACTIONS = new Set(["check", "start", "install", "uninstall"]);

// GET /api/keepalive —— 挂机保活状态：用户开关、心跳、接续、autofix 汇总、守护脚本记录。
export async function GET() {
  return NextResponse.json(buildKeepaliveStatus(), { headers: NO_STORE });
}

// PUT /api/keepalive  body: { enabled: boolean }
//
// 「保活」会在这台机器上自动拉起进程/接续任务，属于本机行为 —— 与监听端口、代理、
// 隧道同一条本机限定规则（中继重放的手机请求会 403）。
// 打开开关时清掉停止标记：用户显式要求继续跑，守护脚本不应继续把服务当「已停」。
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!isLocalRequest(req)) {
    return NextResponse.json(
      { error: "Keepalive can only be changed on this computer." },
      { status: 403 },
    );
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }

  if (enabled) clearKeepaliveStopMarker();
  writeKeepaliveSettings({ enabled });
  return NextResponse.json(buildKeepaliveStatus(), { headers: NO_STORE });
}

// POST /api/keepalive  body: { action: "check" | "start" | "install" | "uninstall" }
//
// 唯一碰系统调度的地方：把动作转给 scripts/pi-supervisor.mjs（Windows 计划任务 /
// launchd / systemd）。打包版里脚本可能没被 stage，此时 501 并让界面显示手工命令。
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!isLocalRequest(req)) {
    return NextResponse.json(
      { error: "Keepalive can only be controlled on this computer." },
      { status: 403 },
    );
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = (body as { action?: unknown } | null)?.action;
  if (typeof action !== "string" || !ACTIONS.has(action)) {
    return NextResponse.json(
      { error: "action must be one of check, start, install, uninstall" },
      { status: 400 },
    );
  }

  // PI_KEEPALIVE_SUPERVISOR_SCRIPT 是测试/打包环境的显式覆盖；默认在仓库根找脚本。
  const script = process.env.PI_KEEPALIVE_SUPERVISOR_SCRIPT?.trim() || supervisorScriptPath();
  if (!script || !existsSync(script)) {
    return NextResponse.json(
      {
        error:
          "The supervisor script is not available in this build. Run node scripts/pi-supervisor.mjs "
          + `${action} from a source checkout, or register the scheduled task by hand.`,
      },
      { status: 501 },
    );
  }

  const args = [script, action, ...(action === "check" ? ["--respect-stop"] : [])];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: process.cwd(),
      timeout: 30_000,
      windowsHide: true,
    });
    return NextResponse.json(
      { ok: true, action, exitCode: 0, output: tail(stdout || stderr) },
      { headers: NO_STORE },
    );
  } catch (error) {
    // 非零退出是守护脚本的正常语义（1=可重启/未运行，2=需人工，3=已停），
    // 不是 HTTP 层的失败：把退出码与输出原样交给界面显示。
    const failure = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    const exitCode = typeof failure.code === "number" ? failure.code : null;
    return NextResponse.json(
      {
        ok: false,
        action,
        exitCode,
        output: tail(`${failure.stdout ?? ""}${failure.stderr ?? ""}`) || failure.message,
      },
      { headers: NO_STORE },
    );
  }
}

function tail(value: string): string {
  return value.length > 4000 ? value.slice(-4000) : value;
}
