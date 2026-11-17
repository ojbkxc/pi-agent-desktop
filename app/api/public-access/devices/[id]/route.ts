import { NextResponse } from "next/server";
import { isLocalRequest } from "@/lib/remote-access";
import { isApiRequestAllowed } from "@/lib/request-security";
import { listDevices, revokeDevice } from "@/lib/public-access/devices";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * DELETE /api/public-access/devices/[id]
 *
 * 撤销一台手机：删掉它的设备行，下一次请求就验不过（换回 web 密码或重新配对）。
 * 只允许在电脑上操作，与 /api/relay/devices/[id] 一致。
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "Phones are managed on this computer." }, { status: 403 });
  }
  if (!revokeDevice(id)) {
    return NextResponse.json({ error: "That phone is not paired (any more)." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, devices: listDevices() }, { headers: NO_STORE });
}
