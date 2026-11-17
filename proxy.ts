import { NextResponse, type NextRequest } from "next/server";
import {
  getAuthRetryAfterMs,
  recordAuthFailure,
  retryAfterSeconds,
} from "@/lib/auth-throttle";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  isRemoteAccessHost,
  isTailscaleFunnelRequest,
  isRemoteAccessRequestAuthorized,
  readRemoteAccessConfig,
} from "@/lib/remote-access";
import { readRelayMark } from "@/lib/relay/mark";
import { isPublicAccessRequestHost, readPublicAccessConfig } from "@/lib/public-access/settings";
import { isDeviceAuthenticatedRequest, isPublicAccessPairingPath } from "@/lib/public-access/devices";
import {
  isValidWebSessionToken,
  isValidBasicAuthorization,
  isWebPasswordEnabled,
  PI_WEB_SESSION_COOKIE,
} from "@/lib/web-auth";

function tooManyAttempts(retryAfterMs: number): NextResponse {
  return new NextResponse("Too many failed attempts", {
    status: 429,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": String(retryAfterSeconds(retryAfterMs)),
    },
  });
}

export function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  // Tailscale Funnel puts this port on the public internet. Without a web password
  // that is a shell for anyone, so refuse it however the Host header reads.
  // 无参的双来源判定：env `PI_WEB_PASSWORD` 或设置文件里的密码记录（lib/web-auth.ts）。
  if (isTailscaleFunnelRequest(request) && !isWebPasswordEnabled()) {
    return new NextResponse("Pi refuses Tailscale Funnel (public) traffic. Use tailscale serve, which keeps it inside your tailnet.", {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // A paired phone's request, replayed from 127.0.0.1 by the relay connector after
  // its Noise session authenticated the device key. Host and Origin are the
  // connector's own, and device keys take the place of the web password. A mark
  // this process did not issue is refused outright.
  const relayMark = readRelayMark(request);
  if (relayMark === "forged") {
    return isApiRequest
      ? NextResponse.json({ error: "Untrusted relay request" }, { status: 403 })
      : new NextResponse("Untrusted relay request", { status: 403 });
  }
  if (relayMark) return NextResponse.next();

  // The Cloudflare tunnel's hostname is only trusted with a web password (see
  // lib/request-security.ts). A password set either way counts — the
  // PI_WEB_PASSWORD environment variable **or** the record Settings writes — so
  // this only fires when nobody has set one at all. Point at the local Settings
  // page (the only place that can turn it on) instead of naming the env variable.
  if (!isWebPasswordEnabled()
    && isPublicAccessRequestHost(request, readPublicAccessConfig())) {
    return new NextResponse(
      "Pi refuses public tunnel traffic until a web password is set. Set one in Settings > General > Server on this computer, then reload this page.",
      {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  if (!isTrustedRequest) {
    // The tailnet name from Settings › Remote access, reached without a Tailscale user:
    // Funnel (public) traffic, a tagged device, or a login that is not on the list.
    const remoteAccess = readRemoteAccessConfig();
    if (remoteAccess && isRemoteAccessHost(request, remoteAccess)
      && !isRemoteAccessRequestAuthorized(request, remoteAccess)) {
      return new NextResponse("Remote access needs a signed-in Tailscale device that is allowed in Pi's settings.", {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  if (!isWebPasswordEnabled()) {
    // No password at all: the app runs unauthenticated as before (this is the
    // local default). `/login` stays reachable instead of redirecting away — it
    // doubles as the first-time "set a web password" page, which is the only way
    // in without touching the environment. Setting it is local-only (the route
    // checks isLocalRequest), so a remote visitor can never claim the machine.
    return NextResponse.next();
  }

  let authenticated = isValidWebSessionToken(request.cookies.get(PI_WEB_SESSION_COOKIE)?.value)
    // A paired phone carries a device token in `__Host-pi-remote` (or as a Bearer
    // header): that is the password-free path the QR pairing hands out. The row
    // can be revoked on the computer at any time, and expiry is enforced here.
    || isDeviceAuthenticatedRequest(request);
  if (!authenticated
    && isPublicAccessPairingPath(request.nextUrl.pathname)
    && isPublicAccessRequestHost(request, readPublicAccessConfig())) {
    // The phone is still pairing: the one-time secret / claimSecret in its body is
    // the credential. Only the tunnel's own hostname reaches these paths.
    authenticated = true;
  }
  const authorization = isApiRequest ? request.headers.get("authorization") : null;
  if (!authenticated && authorization && /^Basic\s/i.test(authorization)) {
    // Every Basic header is a password guess, so it shares the login form's
    // throttle; otherwise any API path (or GET /api/web-auth) answers guesses
    // at full speed. While blocked even the right password is refused, or the
    // answer would leak. A success does not reset the counter: Basic clients
    // authenticate on every request, and each reset would hand an interleaved
    // guesser a fresh short block.
    const retryAfterMs = getAuthRetryAfterMs();
    if (retryAfterMs > 0) return tooManyAttempts(retryAfterMs);
    authenticated = isValidBasicAuthorization(authorization);
    if (!authenticated) recordAuthFailure();
  }
  if (request.nextUrl.pathname === "/login") {
    return authenticated
      ? NextResponse.redirect(new URL("/", request.url))
      : NextResponse.next();
  }
  if (request.nextUrl.pathname === "/api/web-auth") return NextResponse.next();
  // The Tauri shell's startup probe is a bare GET with no cookie or Basic
  // header; with a web password set it would otherwise 401 for the whole
  // startup window and the shell would quit. The endpoint only echoes this
  // process's random instance id, so exempting it widens nothing.
  if (request.nextUrl.pathname === "/api/desktop/identity") return NextResponse.next();

  if (!authenticated) {
    if (!isApiRequest) {
      const loginUrl = new URL("/login", request.url);
      if (request.nextUrl.search) {
        loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
      }
      return NextResponse.redirect(loginUrl);
    }
    // No `WWW-Authenticate: Basic` challenge: it makes browsers pop a native
    // username + password dialog, and this app authenticates by password only
    // (the /login form). API clients that want Basic still send the header
    // themselves — it is accepted above; nothing is advertised.
    return new NextResponse("Authentication required", {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  return NextResponse.next();
}

export const config = { matcher: ["/", "/login", "/api/:path*"] };
