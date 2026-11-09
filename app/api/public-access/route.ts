import { NextResponse } from "next/server";
import { isLocalRequest } from "@/lib/remote-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isWebPasswordEnabled } from "@/lib/web-auth";
import { resolveCloudflaredBinary } from "@/lib/public-access/binary";
import { installCloudflared } from "@/lib/public-access/install";
import { parsePublicAccessUpdate, readPublicAccessConfig } from "@/lib/public-access/settings";
import { ensurePublicAccessManager } from "@/lib/public-access/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// GET /api/public-access - 配置视图（不含 token）+ 运行状态 + 二进制可用性。
export async function GET(req: Request) {
  const binary = resolveCloudflaredBinary();
  return NextResponse.json(
    {
      view: ensurePublicAccessManager().getView(),
      binary: { available: binary !== null, source: binary?.source ?? null },
      passwordSet: isWebPasswordEnabled(process.env.PI_WEB_PASSWORD),
      local: isLocalRequest(req),
    },
    { headers: NO_STORE },
  );
}

// PUT /api/public-access  body: { enabled, mode, localPort?, token?, customUrl?, autoStart? }
// 开洞是本机上的决定：手机或公网来的请求一律拒绝。
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "Public access can only be changed on this computer." }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let manager;
  try {
    manager = ensurePublicAccessManager();
    const parsed = parsePublicAccessUpdate(await req.json(), readPublicAccessConfig());
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    if (parsed.config.enabled && !isWebPasswordEnabled(process.env.PI_WEB_PASSWORD)) {
      return NextResponse.json(
        { error: "Set PI_WEB_PASSWORD before exposing the server on the internet", code: "configuration" },
        { status: 409 },
      );
    }
    await manager.configure(parsed.config);
    return NextResponse.json({ view: manager.getView() }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: NO_STORE },
    );
  }
}

// POST /api/public-access  body: { action: "start" | "stop" | "auto-start" } + { enabled? }
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "Public access can only be changed on this computer." }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const manager = ensurePublicAccessManager();
  let body: { action?: unknown; enabled?: unknown };
  try {
    body = await req.json() as { action?: unknown; enabled?: unknown };
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }
  try {
    switch (body.action) {
      case "start": {
        if (!isWebPasswordEnabled(process.env.PI_WEB_PASSWORD)) {
          return NextResponse.json(
            { error: "Set PI_WEB_PASSWORD before exposing the server on the internet", code: "configuration" },
            { status: 409 },
          );
        }
        await manager.start();
        break;
      }
      case "stop":
        await manager.stop();
        break;
      case "auto-start":
        manager.setAutoStart(body.enabled === true);
        break;
      case "install-binary": {
        const result = await installCloudflared();
        if (!result.ok) {
          // 界面按 code 本地化，message 只作为详情（title）。别再像以前那样把
          // stderr/Node 报错（如 "Cannot find module …"）当主文案丢进中文界面。
          // code: "missing-script" = 打包漏了 scripts/prepare-cloudflared.mjs。
          return NextResponse.json(
            { error: "cloudflared install failed", code: result.code, detail: result.message },
            { status: 502, headers: NO_STORE },
          );
        }
        break;
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
    return NextResponse.json({ view: manager.getView() }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "runtime" },
      { status: 500, headers: NO_STORE },
    );
  }
}
