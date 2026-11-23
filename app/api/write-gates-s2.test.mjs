import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * S2 批次回归：读 body 但此前没有 403/415 的写路由，现在必须有完整三闸门。
 *
 * 审计判定（api-guard）：这些路由的 JSON 解析多数已有 try/catch→400 或 readJsonBody，
 * 缺的是 Content-Type 闸门与来源守卫——约定链是 来源守卫 → 415 → 400(JSON)。
 * 这里逐路由用两个探针打真 handler：
 *  - text/plain 探针必须 415；
 *  - 伪造 Origin 探针必须 403（isApiRequestAllowed 拒非同源浏览器请求）。
 */
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-s2-gates-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

const ROUTES = [
  ["./terminal/route.ts", "POST"],
  ["./skills/route.ts", "PATCH"],
  ["./worktrees/route.ts", "POST"],
  ["./worktrees/route.ts", "PUT"],
  ["./worktrees/route.ts", "DELETE"],
  ["./worktrees/fetch/route.ts", "POST"],
  ["./auth/api-key/[provider]/route.ts", "POST"],
  ["./auth/login/[provider]/route.ts", "POST"],
  ["./models/default/route.ts", "PUT"],
  ["./models/enabled/route.ts", "PUT"],
  ["./models-config/route.ts", "PUT"],
  ["./push/subscribe/route.ts", "POST"],
  ["./push/test/route.ts", "POST"],
  ["./push/unsubscribe/route.ts", "POST"],
  ["./teams/quota/route.ts", "PUT"],
  ["./teams/[team]/assignments/route.ts", "POST"],
  ["./teams/[team]/lifecycle/route.ts", "POST"],
  ["./teams/[team]/members/route.ts", "PATCH"],
  ["./teams/[team]/members/route.ts", "POST"],
  ["./teams/[team]/runtime-control/member/route.ts", "POST"],
  ["./teams/[team]/runtime-control/route.ts", "POST"],
];

const ROUTE_PARAMS = {
  "./auth/api-key/[provider]/route.ts": { provider: "kimi-coding" },
  "./auth/login/[provider]/route.ts": { provider: "kimi-coding" },
  "./teams/[team]/assignments/route.ts": { team: "demo" },
  "./teams/[team]/lifecycle/route.ts": { team: "demo" },
  "./teams/[team]/members/route.ts": { team: "demo" },
  "./teams/[team]/runtime-control/member/route.ts": { team: "demo" },
  "./teams/[team]/runtime-control/route.ts": { team: "demo" },
};

for (const [file, method] of ROUTES) {
  test(`${file} ${method} refuses a non-JSON content type with 415`, async () => {
    const handler = (await jiti.import(file))[method];
    assert.equal(typeof handler, "function", `${file} must export ${method}`);
    const response = await handler(new Request("http://localhost/api/probe", {
      method,
      headers: { "Content-Type": "text/plain", Host: "localhost" },
      body: "not json",
    }), { params: Promise.resolve(ROUTE_PARAMS[file] ?? { id: "probe" }) });
    assert.equal(response.status, 415, `${file} ${method} answered ${response.status} for text/plain`);
  });

  test(`${file} ${method} refuses a cross-origin browser request with 403`, async () => {
    const handler = (await jiti.import(file))[method];
    const response = await handler(new Request("http://localhost/api/probe", {
      method,
      headers: {
        "Content-Type": "application/json",
        Host: "localhost",
        Origin: "https://evil.example.com",
        "Sec-Fetch-Site": "cross-site",
      },
      body: "{}",
    }), { params: Promise.resolve(ROUTE_PARAMS[file] ?? { id: "probe" }) });
    assert.equal(response.status, 403, `${file} ${method} answered ${response.status} for a cross-origin browser request`);
  });
}