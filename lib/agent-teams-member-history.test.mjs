import assert from "node:assert/strict";
import test from "node:test";

import { deriveTicketHistory } from "./agent-teams-member-history.ts";

function ticket(id, overrides = {}) {
  return {
    id,
    subject: `task ${id}`,
    description: "",
    ownerId: "m1",
    status: "open",
    dependencies: [],
    assignments: [],
    source: "plan",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function frame(generatedAt, tickets) {
  return { generatedAt, tickets };
}

test("无历史快照 → 空 Map", () => {
  assert.equal(deriveTicketHistory([], 0, "m1").size, 0);
  assert.equal(deriveTicketHistory([], -1, "m1").size, 0);
});

test("selectedIndex 为负 / 无成员 → 空 Map", () => {
  const snaps = [frame("2026-01-01T00:00:10.000Z", [ticket("t1")])];
  assert.equal(deriveTicketHistory(snaps, -1, "m1").size, 0);
  assert.equal(deriveTicketHistory(snaps, 0, "").size, 0);
});

test("跨帧求「首次离开 open / 首次 ended」与耗时（endedAt − 首次出现）", () => {
  const snaps = [
    frame("2026-01-01T00:00:10.000Z", [ticket("t1", { status: "open" })]),
    frame("2026-01-01T00:00:20.000Z", [ticket("t1", { status: "open" })]),
    frame("2026-01-01T00:01:00.000Z", [ticket("t1", { status: "ended" })]),
  ];
  const history = deriveTicketHistory(snaps, 2, "m1");
  const entry = history.get("t1");
  assert.ok(entry);
  assert.equal(entry.ticketId, "t1");
  // status 只有 open/ended 两态，所以「首次离开 open」即首次 ended 的那一帧。
  assert.equal(entry.leftOpenAt, "2026-01-01T00:01:00.000Z");
  assert.equal(entry.endedAt, "2026-01-01T00:01:00.000Z");
  // 首次出现取票自带 createdAt（00:00:00）→ ended 01:00 = 60s。
  assert.equal(entry.durationMs, 60_000);
});

test("只看到选中帧之前的帧：尚未 ended 的票 durationMs / endedAt 为 null", () => {
  const snaps = [
    frame("2026-01-01T00:00:10.000Z", [ticket("t1", { status: "open" })]),
    frame("2026-01-01T00:01:00.000Z", [ticket("t1", { status: "ended" })]),
  ];
  const history = deriveTicketHistory(snaps, 0, "m1");
  const entry = history.get("t1");
  assert.equal(entry.endedAt, null);
  assert.equal(entry.leftOpenAt, null);
  assert.equal(entry.durationMs, null);
});

test("只统计指定成员的票（ownerId 匹配）", () => {
  const snaps = [
    frame("2026-01-01T00:01:00.000Z", [
      ticket("mine", { ownerId: "m1", status: "ended" }),
      ticket("theirs", { ownerId: "m2", status: "ended" }),
    ]),
  ];
  const history = deriveTicketHistory(snaps, 0, "m1");
  assert.deepEqual([...history.keys()], ["mine"]);
});

test("首次离开 open 的时间早于 ended 时，两者分别记录", () => {
  // 构造一个非 open 也非 ended 的中间态（防御未来状态扩展）：leftOpen 早于 ended。
  const snaps = [
    frame("2026-01-01T00:00:10.000Z", [ticket("t1", { status: "open" })]),
    frame("2026-01-01T00:00:30.000Z", [ticket("t1", { status: "running" })]),
    frame("2026-01-01T00:01:00.000Z", [ticket("t1", { status: "ended" })]),
  ];
  const entry = deriveTicketHistory(snaps, 2, "m1").get("t1");
  assert.equal(entry.leftOpenAt, "2026-01-01T00:00:30.000Z");
  assert.equal(entry.endedAt, "2026-01-01T00:01:00.000Z");
});

test("首次出现取票 createdAt 缺失时的帧时间，duration 按它算", () => {
  const snaps = [
    frame("2026-01-01T00:00:10.000Z", [ticket("t1", { createdAt: "", status: "open" })]),
    frame("2026-01-01T00:00:40.000Z", [ticket("t1", { createdAt: "", status: "ended" })]),
  ];
  const entry = deriveTicketHistory(snaps, 1, "m1").get("t1");
  assert.equal(entry.durationMs, 30_000);
});
