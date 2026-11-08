import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const {
  computeTeamUsage,
  computeTeamEnded,
  TEAM_USAGE_ENTRY_BUDGET,
} = await jiti.import("@/lib/agent-teams-team-usage.ts");

const RAW_NAME = "前端重构队";
const MEMBERS = [
  { agentId: "m-impl", name: "impl", sessionId: "sess-impl" },
  { agentId: "m-qa", name: "qa" },
];

async function setupTeam(t, { files = {}, config = true, lifecycleEntries = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, RAW_NAME);
  await mkdir(dir, { recursive: true });
  if (config) {
    await writeFile(join(dir, "config.json"), JSON.stringify({ name: RAW_NAME, members: MEMBERS }));
  }
  if (Object.keys(lifecycleEntries).length > 0) {
    await writeFile(join(dir, "lifecycle.json"), JSON.stringify({ version: 1, members: lifecycleEntries }));
  }
  for (const [relative, content] of Object.entries(files)) {
    const full = join(dir, relative);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return { root, dir };
}

function fakeDeps({ running = [], probeThrows = false, instance = false } = {}) {
  const runningSet = new Set(running);
  const calls = [];
  return {
    calls,
    deps: {
      probeRunning(sessionId) {
        calls.push({ kind: "probeRunning", sessionId });
        if (probeThrows) throw new Error("rpc registry unavailable");
        return runningSet.has(sessionId);
      },
      hasLifecycleInstance(rawName) {
        calls.push({ kind: "hasInstance", rawName });
        return instance;
      },
    },
  };
}

test("du 统计 bytes/files/lastActivityAt，子目录递归", async (t) => {
  const { dir } = await setupTeam(t, {
    files: { "config.json": "x".repeat(100), "inboxes/impl.json": "y".repeat(50) },
  });
  const { deps } = fakeDeps({ running: [] });
  const usage = await computeTeamUsage(RAW_NAME, (name) => join(dir, "..", name), deps, 1_000_000_000_000);

  assert.equal(usage.bytes, 150);
  assert.equal(usage.files, 2);
  assert.equal(usage.truncated, false);
  assert.ok(usage.lastActivityAt !== null && usage.lastActivityAt > 0);
  assert.equal(typeof usage.idleDays, "number");
});

test("ended 判别：全员 parked + probe=false ⇒ ended；probe=true ⇒ 未结束（T 判别力）", async (t) => {
  const { dir } = await setupTeam(t, {
    lifecycleEntries: {
      impl: { name: "impl", status: "parked", generation: 2, sessionId: "sess-impl" },
    },
  });

  const { deps: stopped } = fakeDeps({ instance: true, running: [] });
  assert.equal(await computeTeamEnded(dir, stopped), true, "parked + probe=false = ended");

  const { deps: running } = fakeDeps({ instance: true, running: ["sess-impl"] });
  assert.equal(await computeTeamEnded(dir, running), false, "parked 账面但会话在跑 = 未结束（probe 是真证据）");
});

test("ended：有实例时 idle 不算结束（2 分钟 TTL 窗口内算活跃）", async (t) => {
  const { dir } = await setupTeam(t, {
    lifecycleEntries: { impl: { name: "impl", status: "idle", generation: 2, sessionId: "sess-impl" } },
  });
  const { deps } = fakeDeps({ instance: true, running: [] });
  assert.equal(await computeTeamEnded(dir, deps), false, "idle ≠ ended");
});

test("ended：无实例时磁盘 running 旧账不作数，probe=false 即 ended（v4 §2 同款）", async (t) => {
  const { dir } = await setupTeam(t, {
    lifecycleEntries: { impl: { name: "impl", status: "running", generation: 9, sessionId: "sess-impl" } },
  });
  const { deps } = fakeDeps({ instance: false, running: [] });
  assert.equal(await computeTeamEnded(dir, deps), true);
});

test("ended：config 缺失/损坏/空名册 ⇒ null（无法判定），probe 抛错 ⇒ null", async (t) => {
  const broken = await setupTeam(t, { config: false });
  const { deps } = fakeDeps({ running: [] });
  assert.equal(await computeTeamEnded(broken.dir, deps), null);

  const probed = await setupTeam(t, {
    lifecycleEntries: { impl: { name: "impl", status: "parked", generation: 1, sessionId: "sess-impl" } },
  });
  const { deps: throwing } = fakeDeps({ probeThrows: true });
  await assert.rejects(
    () => computeTeamEnded(probed.dir, throwing),
    /rpc registry unavailable/,
    "probe 抛错原样上抛，由 computeTeamUsage 转 null",
  );
  const usage = await computeTeamUsage(RAW_NAME, (name) => join(probed.dir, "..", name), throwing);
  assert.equal(usage.ended, null);
  assert.match(usage.usageError, /rpc registry unavailable/);
});

test("T3 纯净性：usage 前后目录内容与 mtime、registry 调用形态零变化", async (t) => {
  const { dir } = await setupTeam(t, {
    files: { "inboxes/qa.json": "{}", "acks/receipts.jsonl": "r1\n" },
    lifecycleEntries: { impl: { name: "impl", status: "parked", generation: 1, sessionId: "sess-impl" } },
  });
  const before = { dir: join(dir, "config.json"), content: await readFile(join(dir, "config.json"), "utf8") };
  const entriesBefore = Object.keys(await readFile(join(dir, "lifecycle.json"), "utf8")).length;

  const { deps, calls } = fakeDeps({ instance: false, running: [] });
  const usage = await computeTeamUsage(RAW_NAME, (name) => join(dir, "..", name), deps);

  assert.equal(await readFile(before.dir, "utf8"), before.content, "config 内容不变");
  assert.equal(Object.keys(await readFile(join(dir, "lifecycle.json"), "utf8")).length, entriesBefore, "lifecycle 不变");
  assert.ok(calls.every((call) => call.kind === "hasInstance" || call.kind === "probeRunning"),
    "只读 Map + 真探，绝无 getLifecycle 类副作用");
  assert.equal(usage.ended, true, "全员 parked + probe=false");
  const after = await readFile(join(dir, "lifecycle.json"), "utf8");
  assert.ok(after.includes("parked"), "lifecycle 条目原样");
});

test("du 预算：条目超 TEAM_USAGE_ENTRY_BUDGET 截断（truncated 如实），不全局放大", async (t) => {
  const { dir } = await setupTeam(t, { config: true });
  const budget = TEAM_USAGE_ENTRY_BUDGET;
  for (let index = 0; index < budget + 5; index += 1) {
    await writeFile(join(dir, `f${index}.txt`), "z");
  }
  const { deps } = fakeDeps({ running: [] });
  const usage = await computeTeamUsage(RAW_NAME, (name) => join(dir, "..", name), deps);
  assert.equal(usage.truncated, true, "预算超出如实标记");
  assert.ok(usage.files <= budget, "统计停在预算内");
});

test("du 容错：目录不可读 ⇒ bytes:null + usageError，ended 仍尽力判定", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-usage-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { deps } = fakeDeps({ running: [] });
  const usage = await computeTeamUsage("ghost", (name) => join(root, name), deps);
  assert.equal(usage.bytes, null);
  assert.match(usage.usageError, /不可读|ENOENT|不/s);
  assert.ok("ended" in usage, "ended 字段始终存在（可为 null）");
});

test("mtime 调整：lastActivityAt 取最大 mtime，idleDays 按给定 now 折算", async (t) => {
  const { dir } = await setupTeam(t, { files: { "a.txt": "1", "b.txt": "2" } });
  const old = new Date("2026-01-01T00:00:00Z").getTime();
  const newer = old + 3 * 86_400_000;
  // 目录内全部文件（含 setupTeam 写的 config.json）统一调 mtime，否则新建文件的
  // now-mtime 会盖过 utimes 设的值。
  await utimes(join(dir, "config.json"), new Date(old), new Date(old));
  await utimes(join(dir, "a.txt"), new Date(old), new Date(old));
  await utimes(join(dir, "b.txt"), new Date(newer), new Date(newer));
  const { deps } = fakeDeps({ running: [] });
  const usage = await computeTeamUsage(RAW_NAME, (name) => join(dir, "..", name), deps, newer + 7 * 86_400_000);
  assert.equal(usage.lastActivityAt, newer, "取最新 mtime");
  assert.equal(usage.idleDays, 7, "≥7 天阈值由 UI 提示，本模块只算天数");
});

test("ENOTDIR/目录不可读 ⇒ bytes:null + usageError，绝不静默 bytes:0（lead 收尾判据）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-usage-enotdir-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // dirFor 指向一个**文件**：readdir 得到 ENOTDIR（非 ENOENT）——measureDir 必须上抛，
  // 由 computeTeamUsage 转 bytes:null + usageError；静默返回 [] 会谎报「空目录」。
  const filePath = join(root, "not-a-dir");
  await writeFile(filePath, "blocker");
  const { deps } = fakeDeps({ running: [] });
  const usage = await computeTeamUsage(RAW_NAME, () => filePath, deps);

  assert.equal(usage.bytes, null, "目录级故障必须 bytes:null，不可 bytes:0");
  assert.notEqual(usage.usageError, undefined, "故障原因如实带出");
  assert.equal(usage.ended, null, "config 不可读（ENOTDIR）⇒ ended 无法判定");
});
