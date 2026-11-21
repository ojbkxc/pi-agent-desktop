import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/skills/redteam`：状态码、安装/移除的磁盘效果与拒绝路径。
 * agent dir 用 `PI_CODING_AGENT_DIR` 指向临时目录，不碰真实 `~/.pi`。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const route = await jiti.import("./route.ts");

const LOOPBACK_HEADERS = { Host: "localhost" };

function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "pi-redteam-route-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    });
}

const postRequest = (body, contentType = "application/json") => new Request("http://localhost/api/skills/redteam", {
  method: "POST",
  headers: { ...LOOPBACK_HEADERS, ...(contentType ? { "Content-Type": contentType } : {}) },
  body: JSON.stringify(body),
});

test("GET 返回包状态：随应用提供 23 个，默认未安装", async () => {
  await withAgentDir(async () => {
    const response = await route.GET();
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.status.bundled, true);
    assert.equal(data.status.total, 23);
    assert.equal(data.status.installed, 0);
  });
});

test("POST install 写盘，uninstall 清掉", async () => {
  await withAgentDir(async (agentDir) => {
    const installed = await route.POST(postRequest({ action: "install" }));
    assert.equal(installed.status, 200);
    const installedData = await installed.json();
    assert.equal(installedData.result.installed, 23);
    assert.equal(installedData.status.installed, 23);
    assert.ok(existsSync(join(agentDir, "skills", "redteam", ".redteam-pack.json")));

    const removed = await route.POST(postRequest({ action: "uninstall" }));
    assert.equal(removed.status, 200);
    const removedData = await removed.json();
    assert.equal(removedData.result.removed, true);
    assert.equal(removedData.status.installed, 0);
  });
});

test("未知 action → 400；缺 JSON Content-Type → 415", async () => {
  await withAgentDir(async () => {
    assert.equal((await route.POST(postRequest({ action: "explode" }))).status, 400);
    assert.equal((await route.POST(postRequest({ action: "install" }, ""))).status, 415);
  });
});
