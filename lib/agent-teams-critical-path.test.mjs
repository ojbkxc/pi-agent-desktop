import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { criticalPath } = await jiti.import("./agent-teams-critical-path.ts");

/**
 * 关键路径纯函数：最长依赖链、缩点式环兜底、确定性、nextCriticalTask 口径。
 * 覆盖：空、单票、直线链、分叉汇合、等长确定性、环、自依赖、深链（不爆栈）、
 * 缺失依赖、全已完成、failed 计为未完成。
 */

function ticket(id, dependencies = [], options = {}) {
  return {
    id,
    subject: id,
    description: "",
    ownerId: null,
    status: options.status ?? "open",
    dependencies,
    assignments: options.assignments ?? [],
    source: "plan",
    createdAt: options.createdAt ?? id,
  };
}

function ended(id, dependencies = [], options = {}) {
  return ticket(id, dependencies, { ...options, status: "ended" });
}

function failedAssignment() {
  return {
    id: "a1",
    status: "ended",
    memberId: null,
    assignee: "tester",
    sessionId: null,
    startedAt: null,
    result: null,
    outcome: "failed",
  };
}

const ids = (result) => result.path.map((t) => t.id);

test("empty list yields an empty path and no next task", () => {
  const result = criticalPath([]);
  assert.deepEqual(result.path, []);
  assert.equal(result.nextCriticalTask, null);
  assert.equal(result.hasCycle, false);
});

test("a single ticket with no dependencies is its own critical path", () => {
  const solo = ticket("solo");
  const result = criticalPath([solo]);
  assert.equal(result.path.length, 1);
  assert.equal(result.path[0], solo, "returns the original ticket reference");
  assert.equal(result.nextCriticalTask, solo);
  assert.equal(result.hasCycle, false);
});

test("a straight chain is the critical path, root first, leaf last", () => {
  const result = criticalPath([ticket("a", ["b"]), ticket("b", ["c"]), ticket("c")]);
  assert.deepEqual(ids(result), ["c", "b", "a"]);
  assert.equal(result.nextCriticalTask.id, "c", "the earliest unfinished ticket");
  assert.equal(result.hasCycle, false);
});

test("a diamond picks the longest branch, deterministically on ties", () => {
  // d 是根；b、c 都依赖 d；a 依赖 b 和 c。两条等长链 d→b→a / d→c→a。
  const result = criticalPath([
    ticket("a", ["b", "c"]),
    ticket("b", ["d"]),
    ticket("c", ["d"]),
    ticket("d"),
  ]);
  assert.deepEqual(ids(result), ["d", "b", "a"], "tie resolves to the smaller-rank predecessor (b)");
  assert.equal(result.nextCriticalTask.id, "d");

  // 同输入两次、以及打乱输入顺序，结果必须一致。
  const again = criticalPath([
    ticket("a", ["b", "c"]),
    ticket("b", ["d"]),
    ticket("c", ["d"]),
    ticket("d"),
  ]);
  assert.deepEqual(ids(again), ids(result));

  const shuffled = criticalPath([
    ticket("d"),
    ticket("c", ["d"]),
    ticket("a", ["b", "c"]),
    ticket("b", ["d"]),
  ]);
  assert.deepEqual(ids(shuffled), ids(result), "input order must not matter");
});

test("a deeper branch wins over a shorter one regardless of order", () => {
  // 长支： root → mid → leaf （3）；短支： root → other （2）。
  const result = criticalPath([
    ticket("leaf", ["mid"]),
    ticket("mid", ["root"]),
    ticket("other", ["root"]),
    ticket("root"),
  ]);
  assert.deepEqual(ids(result), ["root", "mid", "leaf"]);
});

test("dependency cycles collapse into one component and never loop forever", () => {
  // a ↔ b 成环，c 依赖 a。
  const result = criticalPath([
    ticket("a", ["b"]),
    ticket("b", ["a"]),
    ticket("c", ["a"]),
  ]);
  assert.equal(result.hasCycle, true);
  assert.deepEqual(ids(result).sort(), ["a", "b", "c"]);
  assert.equal(result.path.length, 3, "both cycle members plus the dependent ticket");
  assert.equal(result.nextCriticalTask.id, "a", "first ticket in expanded path order");
});

test("a self dependency is ignored (no cycle, no infinite loop)", () => {
  const result = criticalPath([ticket("a", ["a"])]);
  assert.deepEqual(ids(result), ["a"]);
  assert.equal(result.hasCycle, false);
  assert.equal(result.nextCriticalTask.id, "a");
});

test("a long chain (1200) does not overflow the stack", () => {
  const total = 1200;
  const tickets = [];
  for (let index = 0; index < total; index += 1) {
    const dependencies = index === 0 ? [] : [`t${index - 1}`];
    tickets.push(ticket(`t${index}`, dependencies, { createdAt: String(index).padStart(6, "0") }));
  }
  const result = criticalPath(tickets);
  assert.equal(result.path.length, total);
  assert.equal(result.path[0].id, "t0");
  assert.equal(result.path.at(-1).id, `t${total - 1}`);
  assert.equal(result.hasCycle, false);
});

test("dependencies on unknown tickets are treated as already resolved", () => {
  const result = criticalPath([ticket("x", ["ghost", "y"]), ticket("y")]);
  assert.deepEqual(ids(result), ["y", "x"], "only the real edge survives");

  const loner = criticalPath([ticket("z", ["ghost"])]);
  assert.deepEqual(ids(loner), ["z"]);
  assert.equal(loner.nextCriticalTask.id, "z");
});

test("completed tickets are dropped from the path entirely", () => {
  // 链 a(未完成) → b(完成) → c(完成)：过滤掉完成票后只剩 a。
  const result = criticalPath([ticket("a", ["b"]), ended("b", ["c"]), ended("c")]);
  assert.deepEqual(ids(result), ["a"]);
  assert.equal(result.nextCriticalTask.id, "a");
  assert.equal(result.hasCycle, false);
});

test("an all-completed team yields an empty remaining path", () => {
  const result = criticalPath([ended("a", ["b"]), ended("b", ["c"]), ended("c")]);
  assert.deepEqual(ids(result), []);
  assert.equal(result.nextCriticalTask, null);
  assert.equal(result.hasCycle, false);
});

test("a failed (ended) ticket still counts as unfinished work", () => {
  const result = criticalPath([
    ticket("a", ["b"], { status: "ended", assignments: [failedAssignment()] }),
    ended("b"),
  ]);
  assert.deepEqual(ids(result), ["a"], "the completed b is dropped, the failed a remains");
  assert.equal(result.nextCriticalTask.id, "a", "a failed ticket is not 'completed'");
});

test("a long completed chain cannot hide the real remaining work", () => {
  // 历史长链 t1..t5 全部完成；当前只剩 t6 → t7。这是本次口径修正的核心回归。
  const result = criticalPath([
    ended("t1"),
    ended("t2", ["t1"]),
    ended("t3", ["t2"]),
    ended("t4", ["t3"]),
    ended("t5", ["t4"]),
    ticket("t6"),
    ticket("t7", ["t6"]),
  ]);
  assert.deepEqual(ids(result), ["t6", "t7"], "the remaining chain, not the historical one");
  assert.equal(result.nextCriticalTask.id, "t6", "there is still work to watch");
  assert.equal(result.hasCycle, false);
});

test("an unfinished ticket separated by completed work becomes a new root", () => {
  // t1(完成) → t2(未完成) → t3(未完成)：穿过 t1 的边断开，t2 成为根。
  const result = criticalPath([ended("t1"), ticket("t2", ["t1"]), ticket("t3", ["t2"])]);
  assert.deepEqual(ids(result), ["t2", "t3"]);
  assert.equal(result.nextCriticalTask.id, "t2");
});

test("a single unfinished ticket is its own critical path", () => {
  const result = criticalPath([ended("done"), ticket("todo")]);
  assert.deepEqual(ids(result), ["todo"]);
  assert.equal(result.path.length, 1);
  assert.equal(result.nextCriticalTask.id, "todo");
});

test("determinism holds on the filtered remaining subgraph", () => {
  const build = () => [
    ticket("a", ["b", "c"]),
    ticket("b", ["d"]),
    ticket("c", ["d"]),
    ticket("d"),
    ended("noise1"),
    ended("noise2", ["noise1"]),
  ];
  const first = criticalPath(build());
  const reversed = criticalPath([...build()].reverse());
  assert.deepEqual(ids(first), ["d", "b", "a"]);
  assert.deepEqual(ids(reversed), ids(first), "input order must not matter after filtering");
});

test("independent tickets pick the longest single chain deterministically", () => {
  // 两张无依赖票：默认 createdAt=id，a 在前；长度同为 1 → 取 rank 最小者 a。
  const result = criticalPath([ticket("b"), ticket("a")]);
  assert.equal(result.path.length, 1);
  assert.equal(result.nextCriticalTask.id, "a");
});
