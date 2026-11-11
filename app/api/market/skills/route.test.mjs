import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";

/**
 * 列表路由 `limit` 解析的回归测试。
 *
 * 现象：`Number(searchParams.get("limit"))` 在参数缺省时得到 `Number(null) === 0`，
 * 而 0 是有限数，于是 `Math.max(1, 0)` 把「没传 limit」变成**每页 1 条**——catalog 只回 1 条、
 * live 只回 2 条（每源 1 条）。（本仓 `app/api/sessions/[id]/route.ts` 的 tail 有 `> 0` 守卫，
 * 这里当初漏了。）
 *
 * catalog 路径不发网络，所以直接调用路由处理器即可断言。
 */

const root = await mkdtemp(join(tmpdir(), "pi-market-list-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

let GET;

before(async () => {
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
  ({ GET } = await jiti.import("./route.ts"));
});

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

const list = async (query = "") => {
  const response = await GET(new Request(`http://localhost/api/market/skills${query}`));
  assert.equal(response.status, 200, query);
  return response.json();
};

test("缺省 limit → 12 条（不是 1 条）", async () => {
  const data = await list();
  assert.equal(data.items.length, 12);
  assert.equal(data.nextCursor, "catalog:12");
});

test("limit=24 生效，limit=5 生效", async () => {
  assert.equal((await list("?limit=24")).items.length, 24);
  assert.equal((await list("?limit=5")).items.length, 5);
});

test("limit 超过上限被截到 maxPageSize(24)", async () => {
  assert.equal((await list("?limit=999")).items.length, 24);
});

test("非法 limit（0 / 空 / 非数字）回落 12", async () => {
  for (const query of ["?limit=0", "?limit=", "?limit=abc", "?limit=-3"]) {
    assert.equal((await list(query)).items.length, 12, query);
  }
});
