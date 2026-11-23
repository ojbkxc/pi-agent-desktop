import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * 写路由的「非法 JSON」必须回答 400，而且不能把解析器的原文回给客户端。
 *
 * 仓库的规矩（见 `app/api/purge/route.ts` 与那次 `fix(api): 非法 JSON 返回 400`
 * 的提交）是：来源守卫 → 415（Content-Type）→ 400（JSON 不合法）→ 400（字段不合法）
 * → 500（真的是我们的错）。一批路由仍把 `await req.json()` 放在一个大 try 里，
 * catch 一律 500 并把 `error.message` 回显出去 —— 客户端发个 `{` 就能拿到
 * 「Unexpected end of JSON input」，状态码还告诉调用方「服务器出错」。
 */
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-invalid-json-"));
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
  ["autopilot", "./autopilot/route.ts", "PUT"],
  ["lean-mode", "./lean-mode/route.ts", "PUT"],
  ["network-proxy", "./network-proxy/route.ts", "PUT"],
  ["pinned-sessions", "./pinned-sessions/route.ts", "PUT"],
  ["relay", "./relay/route.ts", "PUT"],
  ["terminal", "./terminal/route.ts", "POST"],
  ["skills", "./skills/route.ts", "PATCH"],
  ["open-in-explorer", "./open-in-explorer/route.ts", "POST"],
];

for (const [name, path, method] of CASES) {
  test(`${name} answers 400, not 500, for a malformed JSON body`, async () => {
    const route = await jiti.import(path);
    const handler = route[method];
    assert.equal(typeof handler, "function", `${path} must export ${method}`);

    const response = await handler(new Request(`http://localhost/api/${name}`, {
      method,
      headers: { "Content-Type": "application/json", Host: "localhost" },
      body: "{",
    }));

    const text = await response.text();
    assert.equal(response.status, 400, `${name} answered ${response.status}: ${text}`);
    // 解析器的原文是内部细节：既没用、又把实现暴露给调用方。
    assert.doesNotMatch(text, /Unexpected|JSON\.parse|position \d+|SyntaxError/i, `${name} leaked the parser error: ${text}`);
  });
}
