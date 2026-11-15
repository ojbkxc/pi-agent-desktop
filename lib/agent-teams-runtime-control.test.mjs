import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 团队运行时控件（暂停/恢复/成员运行时）服务端核心：
 * 状态机三态、lead 不进 release、回执校验、partial 收敛、身份 CAS、paused 才可改成员。
 * 磁盘状态用真实文件（config/plan/lifecycle + PI_TEAM_DIR 指向临时根），release/ensureLive
 * 换假实现（记录调用参数与顺序，可注入失败）。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const {
  readRuntimeControlView,
  readTeamStateForRuntime,
  pauseTeamRuntime,
  resumeTeamRuntime,
  updateMemberRuntime,
  RuntimeControlError,
} = await jiti.import("@/lib/agent-teams-runtime-control.ts");

const RAW_NAME = "前端重构队";
const DIR_NAME = "-----";
const IDENTITY = { leadSessionId: "sess-lead", incarnationId: "inc-1" };

const CONFIG = {
  name: RAW_NAME,
  leadSessionId: "unknown-session",
  members: [
    { agentId: "m-lead", name: "team-lead", sessionId: "sess-lead", joinedAt: 1, cwd: "D:/p" },
    { agentId: "m-impl", name: "impl", sessionId: "sess-impl", joinedAt: 1, cwd: "D:/p" },
    { agentId: "m-qa", name: "qa", sessionId: "sess-qa", joinedAt: 1, cwd: "D:/p" },
  ],
};
const PLAN = {
  planId: "plan-1",
  incarnationId: "inc-1",
  members: [
    { id: "p-impl", name: "impl" },
    { id: "p-docs", name: "docs" }, // plan 独有成员
  ],
};

async function setupTeam(t, { lifecycle = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-control-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const dir = join(root, DIR_NAME);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(CONFIG));
  await writeFile(join(dir, "plan.json"), JSON.stringify(PLAN));
  if (Object.keys(lifecycle).length > 0) {
    await writeFile(join(dir, "lifecycle.json"), JSON.stringify({ version: 1, members: lifecycle }));
  }
  // 可变 lifecycle 内存态：假 release/ensureLive 会像 pi-team 一样改它（readLifecycle 每次现读）。
  const lifecycleState = structuredClone(lifecycle);
  return { root, dir, lifecycleState };
}

/** 假 lifecycle 编排：release/ensureLive 照 pi-team 行为更新 lifecycle 态（回执/复活可见）。 */
function makeDeps({ lifecycleState = {}, releaseOutcome = {}, ensureLiveOutcome = {} } = {}) {
  const calls = [];
  return {
    calls,
    lifecycleState,
    deps: {
      readTeamState: (dirName) => readTeamStateForRuntime(dirName, (name) => join(process.env.PI_TEAM_DIR, name)),
      readLifecycle: async () => lifecycleState,
      resolveLead: async () => "sess-lead",
      async release(rawTeamName, memberName) {
        calls.push({ kind: "release", rawTeamName, memberName });
        const outcome = releaseOutcome[memberName];
        // throws 只生效一次（模拟瞬时故障）：重试成功 ⇒ partial 可收敛。
        if (outcome?.throws) {
          const message = outcome.throws;
          delete releaseOutcome[memberName].throws;
          throw new Error(message);
        }
        if (outcome?.status) return { status: outcome.status, generation: 9 };
        const before = lifecycleState[memberName] ?? { name: memberName, status: "idle", generation: 0 };
        const entry = { ...before, name: memberName, status: "parked", generation: (before.generation ?? 0) + 1 };
        lifecycleState[memberName] = entry;
        return entry;
      },
      async ensureLive(rawTeamName, memberName) {
        calls.push({ kind: "ensureLive", rawTeamName, memberName });
        const outcome = ensureLiveOutcome[memberName];
        if (outcome?.throws) {
          const message = outcome.throws;
          delete ensureLiveOutcome[memberName].throws;
          throw new Error(message);
        }
        const before = lifecycleState[memberName] ?? { name: memberName, status: "parked", generation: 0, sessionId: `sess-${memberName}` };
        const entry = { ...before, name: memberName, status: "idle", generation: (before.generation ?? 0) + 1 };
        lifecycleState[memberName] = entry;
        return { sessionId: entry.sessionId ?? `sess-${memberName}` };
      },
    },
  };
}

const dirFor = (name) => join(process.env.PI_TEAM_DIR, name);

test("视图：无 sidecar ⇒ running（revision 1 / epoch 0），名册合并 plan 独有成员", async (t) => {
  const { lifecycleState } = await setupTeam(t, {
    lifecycle: { impl: { name: "impl", status: "running", sessionId: "sess-impl", generation: 1 } },
  });
  const { deps } = makeDeps({ lifecycleState });
  const view = await readRuntimeControlView(DIR_NAME, dirFor, deps);
  assert.equal(view.status, "running");
  assert.equal(view.revision, 1);
  assert.equal(view.epoch, 0);
  assert.equal(view.teamName, RAW_NAME);
  assert.equal(view.incarnationId, "inc-1", "incarnationId 取 plan");
  assert.equal(view.leadSessionId, "sess-lead", "无 sidecar 时用真实解析 lead");
  assert.deepEqual(view.members.map((m) => m.name), ["team-lead", "impl", "qa", "docs"], "config 在前，plan 独有追加");
  assert.equal(view.members.find((m) => m.name === "impl").status, "running");
  assert.equal(view.members.find((m) => m.name === "docs").status, "waiting", "无 lifecycle 条目 = 等活");
  assert.equal(view.resumeEligibleCount, 0);
});

test("视图：lifecycle parked ⇒ paused 成员计入 resumeEligibleCount", async (t) => {
  const { lifecycleState } = await setupTeam(t, {
    lifecycle: {
      impl: { name: "impl", status: "parked", sessionId: "sess-impl", generation: 2 },
      qa: { name: "qa", status: "aborted", sessionId: "sess-qa", generation: 2 },
    },
  });
  const { deps } = makeDeps({ lifecycleState });
  const view = await readRuntimeControlView(DIR_NAME, dirFor, deps);
  assert.equal(view.members.find((m) => m.name === "impl").status, "paused");
  assert.equal(view.members.find((m) => m.name === "qa").status, "failed");
  assert.equal(view.resumeEligibleCount, 1, "只有 parked 计入可恢复");
});

test("pause：release 只调非 lead 成员；全部 parked ⇒ paused，sidecar 落盘", async (t) => {
  const { dir, lifecycleState } = await setupTeam(t);
  const { calls, deps } = makeDeps({ lifecycleState });
  const view = await pauseTeamRuntime(DIR_NAME, dirFor, deps, IDENTITY);

  const released = calls.filter((c) => c.kind === "release").map((c) => c.memberName);
  assert.deepEqual(released, ["impl", "qa"], "lead（members[0]）绝不 release");
  assert.ok(released.every((name) => name !== "team-lead"), "lead 会话是用户会话，暂停不停它");
  assert.equal(view.status, "paused");
  assert.equal(view.revision, 2, "revision 从无 sidecar 的 1 起步 +1");
  assert.equal(view.epoch, 1);
  assert.ok(typeof view.pausedAt === "number");
  assert.equal(view.resumeEligibleCount, 2, "impl/qa 都 parked");

  // sidecar 落盘可读回
  const record = JSON.parse(await readFile(join(dir, "runtime-control.json"), "utf8"));
  assert.equal(record.status, "paused");
  assert.equal(record.leadSessionId, "sess-lead");
  assert.equal(record.incarnationId, "inc-1");
});

test("pause：plan 独有成员也 release（合并名册口径）", async (t) => {
  const { lifecycleState } = await setupTeam(t, {
    lifecycle: { docs: { name: "docs", status: "running", sessionId: "sess-docs", generation: 1 } },
  });
  const { calls, deps } = makeDeps({ lifecycleState });
  const view = await pauseTeamRuntime(DIR_NAME, dirFor, deps, IDENTITY);
  assert.equal(view.status, "paused");
  const released = calls.filter((c) => c.kind === "release").map((c) => c.memberName);
  assert.ok(released.includes("docs"), "plan 独有成员也要停");
});

test("pause：回执非 parked ⇒ partial + memberErrors（按 sessionId 键）", async (t) => {
  const { lifecycleState } = await setupTeam(t);
  const { deps } = makeDeps({ lifecycleState, releaseOutcome: { qa: { status: "running" } } });
  const view = await pauseTeamRuntime(DIR_NAME, dirFor, deps, IDENTITY);
  assert.equal(view.status, "partial");
  assert.match(view.error, /部分成员未确认停止/);
  assert.ok(view.memberErrors["sess-qa"], "memberErrors 按 sessionId 键");
  assert.ok(view.memberErrors["sess-qa"].includes("qa"));
  assert.equal(view.resumeEligibleCount, 1, "只有 impl parked");
});

test("pause：release 抛错 ⇒ partial；已 paused ⇒ 409；身份不符 ⇒ 409", async (t) => {
  const { lifecycleState } = await setupTeam(t);
  const { deps } = makeDeps({ lifecycleState, releaseOutcome: { impl: { throws: "host.stop 爆了" } } });
  const partial = await pauseTeamRuntime(DIR_NAME, dirFor, deps, IDENTITY);
  assert.equal(partial.status, "partial");
  assert.match(partial.memberErrors["sess-impl"], /host\.stop 爆了/);

  // 再暂停一次：partial 可以收敛（impl 重试成功 ⇒ paused）
  const converged = await pauseTeamRuntime(DIR_NAME, dirFor, deps, IDENTITY);
  assert.equal(converged.status, "paused", "partial 可再暂停收敛");

  // 已 paused ⇒ 409
  await assert.rejects(
    () => pauseTeamRuntime(DIR_NAME, dirFor, deps, IDENTITY),
    (error) => error instanceof RuntimeControlError && error.status === 409 && /已暂停/.test(error.message),
  );

  // 身份不符 ⇒ 409
  await assert.rejects(
    () => pauseTeamRuntime(DIR_NAME, dirFor, deps, { leadSessionId: "other", incarnationId: "inc-1" }),
    (error) => error instanceof RuntimeControlError && error.status === 409 && /身份/.test(error.message),
  );
});

test("resume：paused ⇒ ensureLive 只调 parked/aborted；status running；resume 记录如实", async (t) => {
  const { dir, lifecycleState } = await setupTeam(t);
  const { calls, deps } = makeDeps({ lifecycleState });
  await pauseTeamRuntime(DIR_NAME, dirFor, deps, IDENTITY);
  const view = await resumeTeamRuntime(DIR_NAME, dirFor, deps, IDENTITY, "req-1");

  assert.equal(view.status, "running");
  const revived = calls.filter((c) => c.kind === "ensureLive").map((c) => c.memberName);
  assert.deepEqual(revived, ["impl", "qa"], "parked 成员逐个 ensureLive");
  assert.equal(view.revision, 3, "pause(2) → resume(3)");
  assert.equal(view.epoch, 2);
  assert.equal(view.resumeEligibleCount, 0, "复活后无 parked 成员");

  // resume 记录在 sidecar 上（视图不携带，cc-haha 同款：record 才有 resume）。
  const record = JSON.parse(await readFile(join(dir, "runtime-control.json"), "utf8"));
  assert.equal(record.resume.requestId, "req-1");
  assert.deepEqual(record.resume.startedSessionIds, ["sess-impl", "sess-qa"]);
  assert.ok(record.resume.eligibleSessionIds.includes("sess-impl"));

  // 已 running ⇒ 409
  await assert.rejects(
    () => resumeTeamRuntime(DIR_NAME, dirFor, deps, IDENTITY, "req-2"),
    (error) => error instanceof RuntimeControlError && error.status === 409 && /未在暂停状态/.test(error.message),
  );
});

test("resume：无 sidecar（从未暂停）⇒ 409；ensureLive 抛错 ⇒ partial", async (t) => {
  const { dir, lifecycleState } = await setupTeam(t);
  const { deps } = makeDeps({ lifecycleState });
  await assert.rejects(
    () => resumeTeamRuntime(DIR_NAME, dirFor, deps, IDENTITY, "req-0"),
    (error) => error instanceof RuntimeControlError && error.status === 409,
    "从未暂停的团队不能 resume",
  );

  await pauseTeamRuntime(DIR_NAME, dirFor, deps, IDENTITY);
  // 共享同一 lifecycleState：failing 只在 ensureLive 上注入失败（一次），账面与 deps 一致。
  const { deps: failing } = makeDeps({ lifecycleState, ensureLiveOutcome: { qa: { throws: "没有可复活的会话" } } });
  const view = await resumeTeamRuntime(DIR_NAME, dirFor, failing, IDENTITY, "req-1");
  assert.equal(view.status, "partial");
  assert.match(view.memberErrors["sess-qa"], /没有可复活的会话/);
  const record = JSON.parse(await readFile(join(dir, "runtime-control.json"), "utf8"));
  assert.ok(record.resume.startedSessionIds.includes("sess-impl"), "成功复活的如实记录");
});

test("updateMemberRuntime：running ⇒ 409；paused ⇒ 写 config（model/provider/effort）+ revision++", async (t) => {
  const { dir, lifecycleState } = await setupTeam(t);
  const { deps } = makeDeps({ lifecycleState });

  await assert.rejects(
    () => updateMemberRuntime(DIR_NAME, dirFor, deps, IDENTITY, {
      agentId: "m-impl", providerId: "p2", modelId: "m2",
    }),
    (error) => error instanceof RuntimeControlError && error.status === 409,
    "只有 paused 能改成员运行时",
  );

  await pauseTeamRuntime(DIR_NAME, dirFor, deps, IDENTITY);
  const view = await updateMemberRuntime(DIR_NAME, dirFor, deps, IDENTITY, {
    agentId: "m-impl",
    sessionId: "sess-impl",
    providerId: "p2",
    modelId: "m2",
    effortLevel: "high",
  });
  assert.equal(view.status, "paused");
  assert.equal(view.revision, 3);

  const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
  const impl = config.members.find((m) => m.agentId === "m-impl");
  assert.equal(impl.model, "m2");
  assert.equal(impl.providerId, "p2");
  assert.equal(impl.effortLevel, "high");
  assert.equal(config.members.find((m) => m.agentId === "m-qa").model, undefined, "未提到的成员不动");

  // effortLevel 缺省 = 清掉该字段（回到默认）
  await updateMemberRuntime(DIR_NAME, dirFor, deps, IDENTITY, {
    agentId: "m-impl", providerId: "p2", modelId: "m2",
  });
  const config2 = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
  assert.equal("effortLevel" in config2.members.find((m) => m.agentId === "m-impl"), false, "缺省 effortLevel 清字段");
});

test("updateMemberRuntime：成员不在名册 ⇒ 400；sessionId 不符 ⇒ 409；plan 独有成员可改", async (t) => {
  const { dir, lifecycleState } = await setupTeam(t);
  const { deps } = makeDeps({ lifecycleState });
  await pauseTeamRuntime(DIR_NAME, dirFor, deps, IDENTITY);

  await assert.rejects(
    () => updateMemberRuntime(DIR_NAME, dirFor, deps, IDENTITY, { agentId: "ghost", providerId: "p", modelId: "m" }),
    (error) => error instanceof RuntimeControlError && error.status === 400,
  );
  await assert.rejects(
    () => updateMemberRuntime(DIR_NAME, dirFor, deps, IDENTITY, {
      agentId: "m-impl", sessionId: "stale", providerId: "p", modelId: "m",
    }),
    (error) => error instanceof RuntimeControlError && error.status === 409,
    "会话代际不符拒绝",
  );

  // plan 独有成员：改完补写进 config 名册（applyTeamMemberModelChanges 同口径）
  const view = await updateMemberRuntime(DIR_NAME, dirFor, deps, IDENTITY, {
    agentId: "p-docs", providerId: "p3", modelId: "m3",
  });
  assert.equal(view.revision, 3);
  const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
  const docs = config.members.find((m) => m.agentId === "p-docs");
  assert.ok(docs, "plan 独有成员补写进 config");
  assert.equal(docs.model, "m3");
  assert.equal(docs.providerId, "p3");
});
