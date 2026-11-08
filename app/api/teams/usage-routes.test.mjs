import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  tsconfigPaths: true,
  moduleCache: false,
});
const teamsRoute = await jiti.import("./route.ts");
const lifecycleRoute = await jiti.import("../[team]/lifecycle/route.ts");
const { enqueueTeamMutation, teamDirFor } =
  await jiti.import("@/lib/agent-teams-swimlane-store.ts");

const RAW_NAME = "前端重构队";
const DIR_NAME = "-----";

async function setup(t, { sessionsFiles = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-usage-routes-"));
  const previousDir = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  t.after(async () => {
    if (previousDir === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previousDir;
    await rm(root, { recursive: true, force: true });
  });

  const dir = teamDirFor(RAW_NAME);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify({
    name: RAW_NAME,
    members: [
      { agentId: "m-impl", name: "impl", joinedAt: 1, cwd: "", sessionId: "sess-impl" },
      { agentId: "m-qa", name: "qa", joinedAt: 1, cwd: "" },
    ],
  }));
  await writeFile(join(dir, "lifecycle.json"), JSON.stringify({
    version: 1,
    members: { impl: { name: "impl", status: "parked", generation: 1, sessionId: "sess-impl" } },
  }));

  // 成员会话 jsonl 树（团队目录之外）：reclaim 的删除范围必须完全不触及（T5）。
  for (const [relative, content] of Object.entries(sessionsFiles)) {
    const full = join(root, "sessions", relative);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return { root, dir };
}

function dirname(full) {
  return full.slice(0, Math.max(full.lastIndexOf("\\"), full.lastIndexOf("/")));
}

const teamsGet = () => teamsRoute.GET();

test("T3 GET /api/teams 纯净性：usage 字段平铺、前后目录与 registry 零变化", async (t) => {
  const { dir } = await setup(t);
  const snapshotBefore = (await readdir(dir).catch(() => [])).sort().join(",");
  const lifecycleBefore = await readFile(join(dir, "lifecycle.json"), "utf8");
  const registryBefore = globalThis.__piTeamLifecycles instanceof Map
    ? [...globalThis.__piTeamLifecycles.keys()].sort().join(",")
    : "";

  const res = await teamsGet();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.teams) && body.teams.length >= 1);
  const team = body.teams.find((entry) => entry.name === DIR_NAME);
  assert.ok(team, "名册含该团队");
  // 平铺契约：usage 七字段在团队对象顶层，无 usage 子对象。
  for (const field of ["bytes", "files", "truncated", "lastActivityAt", "ended", "idleDays"]) {
    assert.ok(field in team, `平铺字段 ${field} 存在`);
  }
  assert.equal("usage" in team, false, "不得藏 usage 子对象");
  assert.equal(team.ended, true, "parked 旧账 + probe=false（真 rpc 无此会话）⇒ ended");
  assert.equal(typeof team.bytes, "number");
  assert.equal(team.usageError, undefined, "正常读取无故障");

  assert.equal((await readdir(dir).catch(() => [])).sort().join(","), snapshotBefore, "目录条目不变");
  assert.equal(await readFile(join(dir, "lifecycle.json"), "utf8"), lifecycleBefore, "lifecycle 字节不变");
  const registryAfter = globalThis.__piTeamLifecycles instanceof Map
    ? [...globalThis.__piTeamLifecycles.keys()].sort().join(",")
    : "";
  assert.equal(registryAfter, registryBefore, "registry 键集零变化（无 getLifecycle 副作用）");
});

test("T5 jsonl 守卫：reclaim 成功后 sessions 树文件集合与字节逐个不变，仅团队目录消失", async (t) => {
  const files = {
    "proj-a/sess-impl.jsonl": '{"type":"session"}\n{"type":"message"}\n',
    "proj-a/nested/deep.jsonl": '{"type":"session"}\n',
  };
  const { root, dir } = await setup(t, { sessionsFiles: files });

  const res = await lifecycleRoute.POST(
    new Request(`http://localhost/api/teams/${encodeURIComponent(DIR_NAME)}/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "reclaim" }),
    }),
    { params: Promise.resolve({ team: DIR_NAME }) },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.removed, true, "parked 旧账 + 磁盘+probe=false ⇒ reclaim 成功");
  assert.deepEqual(await readdir(dir).catch(() => []), [], "团队目录已删");

  for (const [relative, content] of Object.entries(files)) {
    assert.equal(await readFile(join(root, "sessions", relative), "utf8"), content,
      `成员会话文件 ${relative} 逐字节不变`);
  }
  assert.ok((await readdir(join(root, "sessions"))).includes("proj-a"), "sessions 树结构不变");
});

test("T8 队列串行：同团队 mutation 严格按入队顺序执行，跨团队互不阻塞", async () => {
  const order = [];
  const first = enqueueTeamMutation(`team:${teamDirFor(RAW_NAME)}`, async () => {
    order.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 40));
    order.push("first:end");
    return 1;
  });
  const second = enqueueTeamMutation(`team:${teamDirFor(RAW_NAME)}`, async () => {
    order.push("second:start");
    return 2;
  });
  const other = enqueueTeamMutation("team:another", async () => {
    order.push("other:start");
    return 3;
  });

  const [r1, r2, r3] = await Promise.all([first, second, other]);
  assert.deepEqual([r1, r2, r3], [1, 2, 3]);
  // 同 key 串行的真正判据：**第二个 mutation 不得在第一个的 start 与 end 之间执行**
  // （first 挂起期间跨团队 mutation 插入是预期并行，不算交错）。
  assert.equal(order.indexOf("second:start") > order.indexOf("first:end"), true,
    "second 在 first 结束后才起跑 = 同 key 无交错执行");
  assert.equal(order.indexOf("second:start") > order.indexOf("first:start"), true,
    "second 晚于 first 启动");
  assert.ok(order.includes("other:start"), "跨团队 mutation 正常执行");
  assert.equal(order.indexOf("other:start") < order.indexOf("first:end"), true,
    "跨团队不被阻塞（可与 first 并行）");
});
