import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const types = await jiti.import("./types.ts");
const store = await jiti.import("./store.ts");
const liveness = await jiti.import("../session-liveness.ts");

const dir = mkdtempSync(join(tmpdir(), "pi-pinned-"));
after(() => {
  store.releaseAllPinnedRegistrations();
  rmSync(dir, { recursive: true, force: true });
});

const ID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// ── 纯逻辑 ──────────────────────────────────────────────

test("角色只有 router / worker 两种", () => {
  assert.equal(types.isSessionRole("router"), true);
  assert.equal(types.isSessionRole("worker"), true);
  for (const bad of ["lead", "", null, undefined, 1]) {
    assert.equal(types.isSessionRole(bad), false, JSON.stringify(bad));
  }
});

test("upsert 保留原 pinnedAt；重复 sessionId 在守卫里被拒绝", () => {
  const first = types.upsertPin(types.emptyPinnedSessions(), ID_A, "router", "分派", "2026-11-16T01:00:00.000Z");
  assert.equal(first.sessions.length, 1);
  const again = types.upsertPin(first, ID_A, "worker", "改角色", "2026-11-16T02:00:00.000Z");
  assert.equal(again.sessions.length, 1, "same id must not duplicate");
  assert.equal(again.sessions[0].role, "worker");
  assert.equal(again.sessions[0].note, "改角色");
  assert.equal(again.sessions[0].pinnedAt, "2026-11-16T01:00:00.000Z", "pin time is preserved on a role change");

  const bad = { version: 1, sessions: [
    { sessionId: ID_A, role: "router", pinnedAt: "2026-11-16T01:00:00.000Z" },
    { sessionId: ID_A, role: "worker", pinnedAt: "2026-11-16T02:00:00.000Z" },
  ] };
  assert.throws(() => types.asPinnedSessionsFile(bad), /duplicate/);
});

test("坏名单结构抛错，不会被当成空表（否则 pin 会被静默抹掉）", () => {
  assert.throws(() => types.asPinnedSessionsFile({ version: 2, sessions: [] }), /unsupported version/);
  assert.throws(() => types.asPinnedSessionsFile({ version: 1 }), /sessions must be an array/);
  assert.throws(
    () => types.asPinnedSessionsFile({ version: 1, sessions: [{ sessionId: ID_A, role: "boss", pinnedAt: "x" }] }),
    /malformed/,
  );
});

test("removePin 幂等，findPin 找不到返回 undefined", () => {
  const file = types.upsertPin(types.emptyPinnedSessions(), ID_A, "router", undefined, "2026-11-16T01:00:00.000Z");
  const removed = types.removePin(file, ID_A);
  assert.equal(removed.sessions.length, 0);
  assert.deepEqual(types.removePin(removed, ID_A), removed, "removing again is a no-op");
  assert.equal(types.findPin(file, ID_B), undefined);
});

test("Router 提示要求后台派活、别自己动手、别轮询", () => {
  assert.match(types.ROUTER_GUIDE, /run_in_background/);
  assert.match(types.ROUTER_GUIDE, /[Dd]elegate/);
  assert.match(types.ROUTER_GUIDE, /[Dd]o not poll/);
  assert.match(types.ROUTER_GUIDE, /[Dd]o not do the implementation yourself/);
});

// ── 存储 + liveness 注册 ────────────────────────────────

test("pin 后该会话的 idle 驱逐被拦住，unpin 后恢复可驱逐", () => {
  store.pinSession(ID_A, "router", "分派", dir);
  assert.equal(store.isSessionPinned(ID_A, dir), true);
  // 这就是 rpc-manager 两条驱逐路径所问的同一个判定。
  assert.equal(liveness.hasActiveSessionLivenessProvider({ sessionId: ID_A }), true);
  assert.equal(liveness.hasActiveSessionLivenessProvider({ sessionId: ID_B }), false);

  store.unpinSession(ID_A, dir);
  assert.equal(store.isSessionPinned(ID_A, dir), false);
  assert.equal(liveness.hasActiveSessionLivenessProvider({ sessionId: ID_A }), false, "unpin must release the provider");
});

test("重复 pin 不叠加 provider（unpin 后必须彻底释放）", () => {
  store.pinSession(ID_A, "router", undefined, dir);
  store.pinSession(ID_A, "worker", undefined, dir);
  assert.equal(liveness.hasActiveSessionLivenessProvider({ sessionId: ID_A }), true);
  store.unpinSession(ID_A, dir);
  assert.equal(
    liveness.hasActiveSessionLivenessProvider({ sessionId: ID_A }),
    false,
    "a leftover provider would pin the session forever",
  );
});

test("重启恢复：清空注册表后对齐磁盘名单，pin 重新生效", () => {
  store.pinSession(ID_B, "worker", "执行", dir);
  // 模拟进程重启：provider 全丢，磁盘名单还在。
  store.releaseAllPinnedRegistrations();
  assert.equal(liveness.hasActiveSessionLivenessProvider({ sessionId: ID_B }), false);
  const { pinned } = store.ensurePinnedRegistrations(dir);
  assert.ok(pinned.includes(ID_B));
  assert.equal(liveness.hasActiveSessionLivenessProvider({ sessionId: ID_B }), true);
  store.unpinSession(ID_B, dir);
});

test("名单里删掉的会话，对齐时会被释放", () => {
  store.pinSession(ID_A, "router", undefined, dir);
  store.pinSession(ID_B, "worker", undefined, dir);
  // 绕过 store 直接改写文件：模拟用户在另一台机器/另一次会话里删除了 pin。
  store.writePinnedSessions(types.removePin(store.readPinnedSessions(dir), ID_A), dir);
  const { released } = store.ensurePinnedRegistrations(dir);
  assert.ok(released.includes(ID_A));
  assert.equal(liveness.hasActiveSessionLivenessProvider({ sessionId: ID_A }), false);
  assert.equal(liveness.hasActiveSessionLivenessProvider({ sessionId: ID_B }), true);
  store.unpinSession(ID_B, dir);
});

test("名单文件损坏时对齐不动已注册的会话（宁可多留，不要误释放）", () => {
  store.pinSession(ID_A, "router", undefined, dir);
  writeFileSync(store.pinnedSessionsFilePath(dir), "{ broken");
  const result = store.ensurePinnedRegistrations(dir);
  assert.deepEqual(result, { pinned: [], released: [] });
  assert.equal(liveness.hasActiveSessionLivenessProvider({ sessionId: ID_A }), true, "the existing registration stays");
  // 但不能静默：设置页要能显示「名单读不出来，pin 未生效」。
  assert.ok(store.getPinnedRegistryHealth().error, "读盘失败必须留下可诊断的健康状态");
  // 文件修好后状态清空（直接写一份合法名单，不能再去读那个坏文件）。
  writeFileSync(store.pinnedSessionsFilePath(dir), JSON.stringify({
    version: 1,
    sessions: [{ sessionId: ID_A, role: "router", pinnedAt: "2026-11-16T01:00:00.000Z" }],
  }));
  store.ensurePinnedRegistrations(dir);
  assert.equal(store.getPinnedRegistryHealth().error, null, "恢复后健康状态要清掉");
  store.unpinSession(ID_A, dir);
});

test("名单不存在属于正常情况，不记为错误", () => {
  const fresh = join(dir, "agent-empty");
  store.ensurePinnedRegistrations(fresh);
  assert.equal(store.getPinnedRegistryHealth().error, null);
});

test("isSessionPinned 读盘失败时按「未 pin」处理，不抛给调用方", () => {
  assert.equal(store.isSessionPinned(ID_A, join(dir, "nonexistent-agent-dir")), false);
});