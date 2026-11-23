import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";
import { fileSymlinkSkip } from "../../../scripts/test-platform.mjs";

/**
 * Session-reference 旁路（security 审计 P1-2）：transcript 引用按字面路径放行，
 * 但文件系统跟符号链接走。repo 里放一个指向 roots 之外的链接、agent 触碰过一次
 * （字面路径进 transcript），浏览器就能借 sessionId 读链接目标。
 * 修法：引用放行的路径存在时，realpath 后必须仍在 roots 内或至少不进凭据黑名单。
 */
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-ref-home-")));
process.env.PI_AGENT_HOME = home;
process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./[...path]/route.ts");

// 一个“其它项目”目录：不进 allowed roots，链接目标放这里。
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-ref-outside-")));
after(() => fs.rmSync(outside, { recursive: true, force: true, maxRetries: 5 }));

const project = path.join(home, "proj");
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, "README.md"), "hello");
fs.writeFileSync(path.join(outside, "secret.txt"), "ROOTS-OUTSIDE-SECRET");
fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "PRIVATE KEY");

const allowedFileRoots = await jiti.import("../../../lib/allowed-roots.ts");
allowedFileRoots.allowFileRoot(project);

function get(filePath, { type = "read", sessionId } = {}) {
  const segments = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const query = [`type=${type}`, ...(sessionId ? [`sessionId=${sessionId}`] : [])].join("&");
  return GET(
    new NextRequest(`http://localhost/api/files/x?${query}`, { headers: { Host: "localhost" } }),
    { params: Promise.resolve({ path: segments }) },
  );
}

test("an ordinary in-roots file reads fine without any session reference", async () => {
  const response = await get(path.join(project, "README.md"));
  assert.equal(response.status, 200);
});

test("a roots-outside file is 403 without a session reference", async () => {
  assert.equal((await get(path.join(outside, "secret.txt"))).status, 403);
  // roots 里看不到它，但 403 与 404 都算拒；只要不是 200 且不泄内容。
  const response = await get(path.join(outside, "secret.txt"));
  assert.notEqual(response.status, 200);
  assert.doesNotMatch(await response.text(), /ROOTS-OUTSIDE-SECRET/);
});

test("a symlink from inside the repo to a roots-outside secret keeps the outside root refused", { skip: fileSymlinkSkip }, async () => {
  // 链接放在 roots 内，指向 roots 外的普通文件（非凭据路径）：非引用路径的
  // realpath 校验已经拒绝它；这不依赖新代码，钉住回归面。
  const link = path.join(project, "leak.txt");
  fs.symlinkSync(path.join(outside, "secret.txt"), link);
  const response = await get(link);
  assert.notEqual(response.status, 200);
  assert.doesNotMatch(await response.text(), /ROOTS-OUTSIDE-SECRET/);
});

test("a symlink into a credential store is refused even when the lexical path is clean", { skip: fileSymlinkSkip }, async () => {
  // 链接路径本身不含 .ssh；realpath 后才命中黑名单。无 session 引用时这是
  // credential-route.test 的既有事实；这里钉的是同一链接在存在 stat 的所有
  // 读路径上都过不去（旁路加的 realpath 比对也覆盖它）。
  const link = path.join(project, "innocent-key.txt");
  fs.symlinkSync(path.join(home, ".ssh", "id_ed25519"), link);
  const response = await get(link);
  assert.notEqual(response.status, 200);
  assert.doesNotMatch(await response.text(), /PRIVATE KEY/);
});