import { NextRequest, NextResponse } from "next/server";
import {
  getAuthRetryAfterMs,
  recordAuthFailure,
  recordAuthSuccess,
  retryAfterSeconds,
} from "@/lib/auth-throttle";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isLocalRequest } from "@/lib/remote-access";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  createWebSessionToken,
  isValidBasicAuthorization,
  isValidWebPassword,
  isValidWebSessionToken,
  isWebPasswordEnabled,
  webPasswordSource,
  PI_WEB_SESSION_COOKIE,
} from "@/lib/web-auth";
import { clearSessionCookie, setSessionCookie } from "./session-cookie";

export const dynamic = "force-dynamic";

// 登录接口在认证之前就读请求体，必须设硬上限：隧道暴露后，任何访问者可用 chunked
// 大包在认证前打满进程内存（数据/测试审计 A-2）。密码本身 ≤1024 字符，16 KB 足够。
const MAX_LOGIN_BODY_BYTES = 16 * 1024;

function tooManyAttempts(retryAfterMs: number): NextResponse {
  return NextResponse.json(
    { error: "Too many failed attempts", retryAfterMs },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(retryAfterSeconds(retryAfterMs)),
      },
    },
  );
}

export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  // 双来源（env 优先，其次设置文件里的记录）：无参调用按优先级解析。
  const enabled = isWebPasswordEnabled();
  const authenticated = !enabled
    || isValidBasicAuthorization(request.headers.get("authorization"))
    || isValidWebSessionToken(request.cookies.get(PI_WEB_SESSION_COOKIE)?.value);
  return NextResponse.json(
    { enabled, authenticated, source: webPasswordSource() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  if (!isWebPasswordEnabled()) {
    return NextResponse.json({ error: "Password authentication is disabled" }, { status: 404 });
  }

  const isLocal = isLocalRequest(request);
  const retryAfterMs = getAuthRetryAfterMs(isLocal ? "local" : "shared", isLocal ? "local" : "remote");
  if (retryAfterMs > 0) {
    return tooManyAttempts(retryAfterMs);
  }

  let body: { password?: unknown } | null;
  try {
    body = await parseJsonWithinLimit(request, MAX_LOGIN_BODY_BYTES) as { password?: unknown } | null;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }
    body = null;
  }
  if (!body || typeof body.password !== "string" || !isValidWebPassword(body.password)) {
    const delayMs = recordAuthFailure(isLocal ? "local" : "shared");
    console.warn(`[web-auth] Password authentication failed; next attempt blocked for ${delayMs}ms`);
    return NextResponse.json(
      { error: "Invalid password", retryAfterMs: delayMs },
      { status: 401, headers: { "Retry-After": String(retryAfterSeconds(delayMs)) } },
    );
  }

  recordAuthSuccess();
  const response = NextResponse.json({ ok: true });
  setSessionCookie(response, request, createWebSessionToken());
  return response;
}

export async function DELETE(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response, request);
  return response;
}
