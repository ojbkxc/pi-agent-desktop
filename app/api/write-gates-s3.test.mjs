import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * S3 批次回归：无 body 的写路由此前完全没有来源守卫（lease、logout、default-cwd、
 * auto-name）。它们不读 body，所以 415 无从谈起；判定只看 403——一个跨源浏览器
 * 请求必须被拒，proxy 层的兜底之外路由自身也要能守住（防绕过 proxy 的内部路径）。
 */
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-s3-guards-"));
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

const CASES = [
  ["./agent/[id]/lease/route.ts", "POST", { id: "sess-1" }],
  ["./auth/logout/[provider]/route.ts", "POST", { provider: "kimi-coding" }],
  ["./default-cwd/route.ts", "POST", {}],
  ["./sessions/[id]/auto-name/route.ts", "POST", { id: "sess-1" }],
];

for (const [file, method, routeParams] of CASES) {
  test(`${file} ${method} refuses a cross-origin browser request with 403`, async () => {
    const handler = (await jiti.import(file))[method];
    assert.equal(typeof handler, "function", `${file} must export ${method}`);
    const response = await handler(new Request("http://localhost/api/probe", {
      method,
      headers: {
        Host: "localhost",
        Origin: "https://evil.example.com",
        "Sec-Fetch-Site": "cross-site",
      },
    }), { params: Promise.resolve(routeParams) });
    assert.equal(response.status, 403, `${file} ${method} answered ${response.status}`);
  });
}