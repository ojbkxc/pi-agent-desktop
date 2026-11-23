import { NextRequest, NextResponse } from "next/server";
import {
  getAuthRetryAfterMs,
  recordAuthFailure,
  recordAuthSuccess,
  retryAfterSeconds,
} from "@/lib/auth-throttle";
import { isLocalRequest } from "@/lib/remote-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  createWebSessionToken,
  webPasswordSource,
} from "@/lib/web-auth";
import {
  clearWebPasswordRecord,
  readWebPasswordRecord,
  verifyWebPasswordHash,
  writeWebPasswordRecord,
} from "@/lib/web-password-store";
import { clearSessionCookie, setSessionCookie } from "../session-cookie";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_PASSWORD_LENGTH = 1024;
// 请求体上限：两个密码字段各 ≤1024 字符，16 KB 足够；防止在认证前缓冲超大请求体。
const MAX_PASSWORD_BODY_BYTES = 16 * 1024;
const NO_STORE = { "Cache-Control": "no-store" } as const;

function jsonError(body: Record<string, unknown>, status: number, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

// PUT /api/web-auth/password — 设置（未设密码时）或修改（已有记录时）web 密码。
// DELETE — 关闭密码（删除设置文件里的记录）。
//
// 安全口径：
// - 改密码改变「谁能进来」，与开隧道、改端口同类：只允许本机操作（isLocalRequest，
//   与 PUT /api/public-access、PUT /api/server-settings 同口径）。
// - 需已登录 session 才能改 —— 由 proxy.ts 的门禁保证（密码启用时 /api/* 一律
//   要 session 或 Basic）；未设密码时没有可验证的会话，首次设置只靠本机限制。
// - 已有记录时必须先验当前密码；错误计入全局登录节流（lib/auth-throttle.ts），
//   这里不会成为绕过节流的猜密码口。
// - env 来源生效时拒绝（409 managed-by-env）：文件记录会被 env 遮蔽，改了也不生效。
// - 改成/关掉后重新签发（或清掉）当前浏览器的 cookie；其它设备的旧 token 因签名
//   密钥（stored hash）轮换而全部失效。日志只记事件，绝不落口令本身。

export async function PUT(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return jsonError({ error: "Untrusted API request" }, 403);
  }
  if (!isLocalRequest(request)) {
    return jsonError(
      { error: "The web password can only be changed on this computer.", code: "local-only" },
      403,
    );
  }
  if (!hasJsonContentType(request)) {
    return jsonError({ error: "Content-Type must be application/json" }, 415);
  }

  if (webPasswordSource() === "env") {
    return jsonError(
      {
        error: "The web password is set through the PI_WEB_PASSWORD environment variable; remove it to manage the password here.",
        code: "managed-by-env",
      },
      409,
    );
  }

  let body: { currentPassword?: unknown; newPassword?: unknown } | null;
  try {
    body = await parseJsonWithinLimit(request, MAX_PASSWORD_BODY_BYTES) as {
      currentPassword?: unknown;
      newPassword?: unknown;
    } | null;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonError({ error: "Request body too large" }, 413);
    }
    body = null;
  }
  if (!body) {
    return jsonError({ error: "Expected a JSON body" }, 400);
  }

  const newPassword = body.newPassword;
  if (typeof newPassword !== "string" || newPassword.length < 1 || newPassword.length > MAX_PASSWORD_LENGTH) {
    return jsonError(
      { error: "The new password must be 1 to 1024 characters.", code: "invalid-new" },
      400,
    );
  }

  const record = readWebPasswordRecord();
  if (record) {
    // 改密码只在 Settings 页发起（isLocalRequest 已在该路由前置校验过），
    // 所以这里按本机口径查询与计数。
    const retryAfterMs = getAuthRetryAfterMs("local", "local");
    if (retryAfterMs > 0) {
      return jsonError(
        { error: "Too many failed attempts", retryAfterMs },
        429,
        { "Retry-After": String(retryAfterSeconds(retryAfterMs)) },
      );
    }

    const currentPassword = body.currentPassword;
    if (typeof currentPassword !== "string" || !verifyWebPasswordHash(currentPassword, record)) {
      const delayMs = recordAuthFailure("local");
      console.warn(`[web-auth] Password change refused: the current password did not verify; next attempt blocked for ${delayMs}ms`);
      return jsonError(
        { error: "Invalid current password", retryAfterMs: delayMs, code: "invalid-current" },
        401,
        { "Retry-After": String(retryAfterSeconds(delayMs)) },
      );
    }
    recordAuthSuccess();
  }

  writeWebPasswordRecord(newPassword);
  console.warn("[web-auth] Web password updated from Settings");

  const response = NextResponse.json({ ok: true, source: "stored" }, { headers: NO_STORE });
  setSessionCookie(response, request, createWebSessionToken());
  return response;
}

export async function DELETE(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return jsonError({ error: "Untrusted API request" }, 403);
  }
  if (!isLocalRequest(request)) {
    return jsonError(
      { error: "The web password can only be changed on this computer.", code: "local-only" },
      403,
    );
  }

  if (webPasswordSource() === "env") {
    return jsonError(
      {
        error: "The web password is set through the PI_WEB_PASSWORD environment variable; remove it to manage the password here.",
        code: "managed-by-env",
      },
      409,
    );
  }

  clearWebPasswordRecord();
  console.warn("[web-auth] Web password removed");

  const response = NextResponse.json({ ok: true, source: null }, { headers: NO_STORE });
  clearSessionCookie(response, request);
  return response;
}
