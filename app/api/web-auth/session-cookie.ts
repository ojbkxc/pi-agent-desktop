import { NextResponse } from "next/server";
import { PI_WEB_SESSION_COOKIE, PI_WEB_SESSION_MAX_AGE } from "@/lib/web-auth";

/**
 * `/api/web-auth`（登录/登出）与 `/api/web-auth/password`（设置/修改/关闭密码）
 * 共用的会话 cookie 读写。cookie 属性必须保持一致：httpOnly + SameSite=Lax +
 * https 下加 Secure（SameSite=Lax 的浏览器登录，见 docs/agents/fork-files-security.md）。
 */
export function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:"
    || request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() === "https";
}

export function setSessionCookie(response: NextResponse, request: Request, token: string): void {
  response.cookies.set({
    name: PI_WEB_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: PI_WEB_SESSION_MAX_AGE,
  });
}

export function clearSessionCookie(response: NextResponse, request: Request): void {
  response.cookies.set({
    name: PI_WEB_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: 0,
  });
}
