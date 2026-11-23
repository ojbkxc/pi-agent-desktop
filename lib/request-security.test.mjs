import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function loadSubject() {
  return import("./request-security.ts");
}

/**
 * 「未设密码」的判定现在是双来源（env + 设置文件里的密码记录）。删除 env 变量的
 * 同时把 PI_CODING_AGENT_DIR 指到一个不存在的空目录，避免读到本机真实的
 * ~/.pi/agent/pi-web/settings.json 记录（跑测试的机器可能真设过密码）。
 */
function emptyAgentDir() {
  return join(tmpdir(), `pi-request-security-test-${process.pid}-empty`);
}

test("allows same-origin and non-browser API requests", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30141",
      "sec-fetch-site": "same-origin",
    },
  })), true);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: { host: "localhost:30141" },
  })), true);
});

test("allows LAN same-origin requests when Next.js uses an internal localhost URL", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "192.168.32.7:30141",
      origin: "http://192.168.32.7:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(request), true);
});

test("allows IPv6 and an explicitly configured hostname", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const ipv6 = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "[::1]:30141",
      origin: "http://[::1]:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  const configured = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "pi-web.internal:30141",
      origin: "http://pi-web.internal:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(ipv6), true);
  assert.equal(isApiRequestAllowed(configured, ["pi-web.internal"]), true);
});

test("rejects cross-origin browser API requests", async () => {
  const { isApiRequestAllowed, shouldCheckApiRequestOrigin } = await loadSubject();
  const post = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    },
  });
  const crossSiteGet = new Request("http://localhost:30141/api/sessions", {
    headers: { host: "localhost:30141", "sec-fetch-site": "cross-site" },
  });
  assert.equal(shouldCheckApiRequestOrigin(post), true);
  assert.equal(isApiRequestAllowed(post), false);
  assert.equal(shouldCheckApiRequestOrigin(crossSiteGet), true);
  assert.equal(isApiRequestAllowed(crossSiteGet), false);
});

test("does not globally trust opaque iframe or alternate loopback origins", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const previewUrl = "http://localhost:30141/api/files/tmp/test.docx?type=preview";
  const opaqueIframe = new Request(previewUrl, {
    headers: {
      host: "localhost:30141",
      origin: "null",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "iframe",
    },
  });
  const alternateLoopback = new Request(previewUrl, {
    headers: {
      host: "localhost:30141",
      origin: "http://127.0.0.1:30141",
      "sec-fetch-site": "cross-site",
    },
  });

  assert.equal(isApiRequestAllowed(opaqueIframe), false);
  assert.equal(isApiRequestAllowed(alternateLoopback), false);
});

test("allows only user-initiated session export document navigations from a PWA", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const navigationHeaders = {
    host: "127.0.0.1:30141",
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "sec-fetch-user": "?1",
  };

  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { headers: navigationHeaders },
  )), true);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions",
    { headers: navigationHeaders },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { headers: { ...navigationHeaders, "sec-fetch-dest": "empty" } },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    {
      headers: {
        ...navigationHeaders,
        "sec-fetch-user": "",
      },
    },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { method: "POST", headers: navigationHeaders },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { headers: { ...navigationHeaders, host: "attacker.example:30141" } },
  )), false);
});

test("rejects an origin that does not match the external request host", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "192.168.32.7:30141",
      origin: "http://attacker.example",
      "sec-fetch-site": "same-site",
    },
  });
  assert.equal(isApiRequestAllowed(request), false);
});

test("rejects DNS rebinding even when browser headers say same-origin", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/skills/install", {
    method: "POST",
    headers: {
      host: "attacker.example:30141",
      origin: "http://attacker.example:30141",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
  });
  assert.equal(isApiRequestAllowed(request), false);
});

test("rejects missing, malformed, and unconfigured Host headers", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test")), false);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    headers: { host: "localhost@attacker.example:30141" },
  })), false);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    headers: { host: "pi-web.internal:30141" },
  })), false);
});

test("recognizes JSON request content types", async () => {
  const { hasJsonContentType } = await loadSubject();
  assert.equal(hasJsonContentType(new Request("http://localhost", {
    headers: { "content-type": "application/json; charset=utf-8" },
  })), true);
  assert.equal(hasJsonContentType(new Request("http://localhost", {
    headers: { "content-type": "application/problem+json" },
  })), true);
  assert.equal(hasJsonContentType(new Request("http://localhost", {
    headers: { "content-type": "text/plain" },
  })), false);
});

test("allows a proxy that reports the scheme out-of-band and rewrites Origin", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  // Azure Dev Tunnels normalizes Host and Origin onto the backend authority
  // but keeps the external scheme in x-forwarded-proto.
  const request = new Request("https://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30141",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(request), true);
});

test("still rejects a foreign origin when a proxy is in front", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const foreignHost = new Request("https://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://attacker.example",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-site",
    },
  });
  const foreignPort = new Request("https://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30142",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-site",
    },
  });
  const alternateLoopback = new Request("https://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://127.0.0.1:30141",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-site",
    },
  });
  const opaque = new Request("https://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "null",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-site",
    },
  });

  assert.equal(isApiRequestAllowed(foreignHost), false);
  assert.equal(isApiRequestAllowed(foreignPort), false);
  assert.equal(isApiRequestAllowed(alternateLoopback), false);
  assert.equal(isApiRequestAllowed(opaque), false);
});

test("does not relax the scheme without same-origin proxy evidence", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("https://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(request), false);

  request.headers.set("x-forwarded-proto", "https");
  request.headers.set("sec-fetch-site", "same-site");
  assert.equal(isApiRequestAllowed(request), false);
});

test("公网隧道域名：只在隧道在线且设了 web 密码时放行", async () => {
  const { isApiRequestHostAllowed } = await loadSubject();
  const config = { origin: "https://pi.example.com" };
  const request = (host) => new Request("http://127.0.0.1:30141/api/test", { headers: { host } });
  const previous = process.env.PI_WEB_PASSWORD;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    delete process.env.PI_WEB_PASSWORD;
    process.env.PI_CODING_AGENT_DIR = emptyAgentDir();
    assert.equal(isApiRequestHostAllowed(request("pi.example.com"), [], null, config), false, "没有 web 密码不放行");
    process.env.PI_WEB_PASSWORD = "pw";
    assert.equal(isApiRequestHostAllowed(request("pi.example.com"), [], null, config), true);
    assert.equal(isApiRequestHostAllowed(request("evil.example.com"), [], null, config), false);
    assert.equal(isApiRequestHostAllowed(request("pi.example.com"), [], null, { origin: "" }), false, "隧道不在线（无 origin）不放行");
    assert.equal(isApiRequestHostAllowed(request("pi.example.com"), [], null, null), false);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previous;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("公网 origin 的同源 API 请求被接受，且同样要求密码", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  const config = { origin: "https://pi.example.com" };
  const request = () => new Request("http://127.0.0.1:30141/api/test", {
    headers: { host: "pi.example.com", origin: "https://pi.example.com" },
  });
  const previous = process.env.PI_WEB_PASSWORD;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    delete process.env.PI_WEB_PASSWORD;
    process.env.PI_CODING_AGENT_DIR = emptyAgentDir();
    assert.equal(isApiRequestOriginAllowed(request(), null, config), false);
    process.env.PI_WEB_PASSWORD = "pw";
    assert.equal(isApiRequestOriginAllowed(request(), null, config), true);
    assert.equal(isApiRequestOriginAllowed(request(), null, { origin: "https://other.example.com" }), false);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previous;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("公网隧道域名：配对手机的 device Cookie 是密码之外的第二条通道", async () => {
  const { isApiRequestHostAllowed, isApiRequestOriginAllowed } = await loadSubject();
  const devices = await import("./public-access/devices.ts");
  const config = { origin: "https://pi.example.com" };
  const previous = process.env.PI_WEB_PASSWORD;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "pi-request-security-devices-"));
  try {
    delete process.env.PI_WEB_PASSWORD;
    process.env.PI_CODING_AGENT_DIR = dir;
    const { device, token } = devices.createDevice({ name: "Phone" });
    const request = () => new Request("http://127.0.0.1:30141/api/test", {
      headers: {
        host: "pi.example.com",
        origin: "https://pi.example.com",
        cookie: `${devices.PUBLIC_ACCESS_DEVICE_COOKIE}=${token}`,
      },
    });
    // 没设 web 密码时，密码门关着 —— 但有效 device token 自证身份。
    assert.equal(isApiRequestHostAllowed(request(), [], null, config), true);
    assert.equal(isApiRequestOriginAllowed(request(), null, config), true);

    // 撤销后立刻回到「两条都没有」：不放行。
    devices.revokeDevice(device.id);
    assert.equal(isApiRequestHostAllowed(request(), [], null, config), false);
    assert.equal(isApiRequestOriginAllowed(request(), null, config), false);

    // 没有凭据时，手写 origin 不会放宽任何东西（原有硬规则不变）。
    const anonymous = new Request("http://127.0.0.1:30141/api/test", {
      headers: { host: "pi.example.com", origin: "https://pi.example.com" },
    });
    assert.equal(isApiRequestHostAllowed(anonymous, [], null, config), false);
    assert.equal(isApiRequestOriginAllowed(anonymous, null, config), false);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previous;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readJsonBody turns a malformed body into a 400, not a 500 with the parser's words", async () => {
  const { readJsonBody } = await loadSubject();
  const jsonPost = (body) => new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  const good = await readJsonBody(jsonPost(JSON.stringify({ a: 1 })));
  assert.equal(good.ok, true);
  assert.deepEqual(good.body, { a: 1 });

  const bad = await readJsonBody(jsonPost("{"));
  assert.equal(bad.ok, false);
  assert.equal(bad.response.status, 400);
  const payload = await bad.response.json();
  assert.deepEqual(payload, { error: "Invalid JSON body" }, "a generic body, never the parser's message");

  // `null` 是合法 JSON：这里只管「能不能解析」，字段校验是路由自己的事。
  const nullBody = await readJsonBody(jsonPost("null"));
  assert.equal(nullBody.ok, true);
  assert.equal(nullBody.body, null);
});
