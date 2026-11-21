import assert from "node:assert/strict";
import test from "node:test";

import { dependencyChain } from "./agent-teams-dependency-focus.ts";

const ticket = (id, dependencies = [], status = "open") => ({
  id,
  subject: id,
  description: "",
  ownerId: null,
  status,
  dependencies,
  assignments: [],
  source: "plan",
  createdAt: "2026-01-01T00:00:00.000Z",
});

test("沿依赖双向收集祖先与后代（多层）", () => {
  // t0 <- t1 <- t2 -> t3（t2 依赖 t1，t3 依赖 t2）
  const tickets = [
    ticket("t0"),
    ticket("t1", ["t0"]),
    ticket("t2", ["t1"]),
    ticket("t3", ["t2"]),
  ];
  const chain = dependencyChain(tickets, "t2");
  assert.deepEqual([...chain].sort(), ["t0", "t1", "t2", "t3"]);
  assert.ok(chain.has("t2"), "焦点票自身在链内");
});

test("互不相连的分支不会被拉进链", () => {
  const tickets = [
    ticket("a"),
    ticket("b", ["a"]),
    ticket("x"),
    ticket("y", ["x"]),
  ];
  const chain = dependencyChain(tickets, "a");
  assert.deepEqual([...chain].sort(), ["a", "b"]);
});

test("环上遍历不无限递归，环内所有票都在链里", () => {
  const tickets = [
    ticket("a", ["b"]),
    ticket("b", ["c"]),
    ticket("c", ["a"]),
    ticket("d", ["a"]),
  ];
  const chain = dependencyChain(tickets, "b");
  assert.deepEqual([...chain].sort(), ["a", "b", "c", "d"]);
});

test("自依赖不会死循环", () => {
  const chain = dependencyChain([ticket("self", ["self"])], "self");
  assert.deepEqual([...chain], ["self"]);
});

test("缺失的依赖 id 安全跳过", () => {
  const tickets = [
    ticket("a", ["ghost"]),
    ticket("b", ["a", "missing"]),
  ];
  const chain = dependencyChain(tickets, "a");
  assert.deepEqual([...chain].sort(), ["a", "b"]);
  assert.ok(!chain.has("ghost"));
});

test("focus 为 null / 空串 / 不在快照里时返回空集合", () => {
  const tickets = [ticket("a")];
  assert.equal(dependencyChain(tickets, null).size, 0);
  assert.equal(dependencyChain(tickets, undefined).size, 0);
  assert.equal(dependencyChain(tickets, "").size, 0);
  assert.equal(dependencyChain(tickets, "nope").size, 0);
});

test("空票列表安全返回空集合", () => {
  assert.equal(dependencyChain([], "a").size, 0);
});
