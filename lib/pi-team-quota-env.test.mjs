import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 桌面配额必须同步给 pi-team，两套闸门同源（团队计数审计 P1-3）。
 *
 * 现象：面板显示还有余量 → 点派发 → `LIMIT_EXCEEDED: global worker limit reached (32)`。
 * 根因：上游 `checkSpawnLimits` 每次现读 `process.env.PI_TEAM_MAX_GLOBAL_WORKERS`（缺省 32），
 * 而桌面那套 `tryReserveTeamWorkerSlot` 用设置项（默认 64/16，`0` = 不限）。两条闸各算各的。
 *
 * 关键映射：上游 `positiveIntFromEnv` **只接受正整数**，桌面 `0`（不限）会被它当成非法值
 * 回落到 32——这正是「我设了不限，怎么还被 32 拦住」的成因。所以同步时要把 0 换成一个大数。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const quotaEnv = await jiti.import("./pi-team-quota-env.ts");

test("desktop limits are copied to the env pi-team reads", () => {
  const env = {};
  const sync = quotaEnv.syncPiTeamQuotaEnv(env, { perTeamLimit: 16, globalLimit: 64 });
  assert.deepEqual(sync, { globalWorkers: 64, maxMembers: 16 });
  assert.equal(env.PI_TEAM_MAX_GLOBAL_WORKERS, "64");
  assert.equal(env.PI_TEAM_MAX_MEMBERS, "16");
});

test("`0` (unlimited on our side) becomes a value pi-team will actually accept", () => {
  // 上游只认正整数：0 会被当成非法值回落到 32。
  const env = {};
  const sync = quotaEnv.syncPiTeamQuotaEnv(env, { perTeamLimit: 0, globalLimit: 0 });
  assert.ok(sync.globalWorkers >= 1_000_000, "an unlimited desktop quota must not collapse to 32 upstream");
  assert.ok(sync.maxMembers >= 1_000_000);
  assert.equal(env.PI_TEAM_MAX_GLOBAL_WORKERS, String(quotaEnv.PI_TEAM_UNLIMITED_WORKERS));
});

test("the sync is idempotent and leaves other env keys alone", () => {
  const env = { PATH: "/usr/bin", PI_TEAM_NAME: "demo" };
  quotaEnv.syncPiTeamQuotaEnv(env, { perTeamLimit: 8, globalLimit: 32 });
  quotaEnv.syncPiTeamQuotaEnv(env, { perTeamLimit: 8, globalLimit: 32 });
  assert.equal(env.PI_TEAM_MAX_GLOBAL_WORKERS, "32");
  assert.equal(env.PI_TEAM_NAME, "demo", "unrelated team identity is untouched");
  assert.equal(env.PATH, "/usr/bin");
});

test("pi-team's own parser accepts every value we write", async () => {
  // 直接问上游：它必须把我们写的值读回同一个数（而不是回落到默认 32）。
  // 用绝对路径加载 dist —— pi-team 的 exports map 不导出 `./dist/constants.js`，
  // 而这个文件的 `positiveIntFromEnv` 正是 gate 的判据所在，值得直接盯住。
  const { existsSync } = await import("node:fs");
  const file = new URL("../node_modules/pi-team/dist/constants.js", import.meta.url).pathname.replace(/^\//, "");
  if (!existsSync(file)) return; // 依赖被裁掉时不假装测过
  const { getMaxGlobalWorkers, getMaxMembersPerTeam } = await jiti.import(file);
  const env = process.env;
  const saved = { g: env.PI_TEAM_MAX_GLOBAL_WORKERS, m: env.PI_TEAM_MAX_MEMBERS };
  try {
    quotaEnv.syncPiTeamQuotaEnv(env, { perTeamLimit: 40, globalLimit: 96 });
    assert.equal(getMaxGlobalWorkers(), 96, "the upstream gate sees our number, not the default 32");
    assert.equal(getMaxMembersPerTeam(), 40);
    // 桌面「不限」映射过去的值也要被上游读成一个大数，而不是回落 32。
    quotaEnv.syncPiTeamQuotaEnv(env, { perTeamLimit: 0, globalLimit: 0 });
    assert.equal(getMaxGlobalWorkers(), quotaEnv.PI_TEAM_UNLIMITED_WORKERS);
  } finally {
    if (saved.g === undefined) delete env.PI_TEAM_MAX_GLOBAL_WORKERS; else env.PI_TEAM_MAX_GLOBAL_WORKERS = saved.g;
    if (saved.m === undefined) delete env.PI_TEAM_MAX_MEMBERS; else env.PI_TEAM_MAX_MEMBERS = saved.m;
  }
});
