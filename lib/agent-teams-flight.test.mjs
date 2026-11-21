import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 编队总线上的消息飞行路线（纯几何）。坐标常量来自
 * lib/agent-teams-formation-layout.ts：LEAD_FOOT=150 / LEAD_BUS_Y=196 /
 * MEMBER_TOP=222 / MEMBER_FOOT=352 / PEER_BUS_Y=372。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { formationFlights } = await jiti.import("./agent-teams-flight.ts");
const layout = await jiti.import("./agent-teams-formation-layout.ts");

const LEAD = { id: "lead", name: "team-lead", centerX: 600, isLead: true };
const ALICE = { id: "w1", name: "alice", centerX: 200, isLead: false };
const BOB = { id: "w2", name: "bob", centerX: 400, isLead: false };
const NODES = [LEAD, ALICE, BOB];

const message = (over = {}) => ({
  id: "m1",
  from: "team-lead",
  to: "alice",
  recipients: ["alice"],
  kind: "direct",
  text: "go",
  timestamp: "2026-11-21T00:00:00Z",
  ...over,
});

test("队长 → 成员：走 lead bus，标注为派工", () => {
  const [flight] = formationFlights(message(), NODES);
  assert.equal(flight.channel, "lead");
  assert.equal(flight.tone, "assignment");
  assert.equal(flight.labelKey, "teams.communication.assignment");
  assert.ok(flight.d.startsWith(`M ${LEAD.centerX},${layout.LEAD_FOOT}`), flight.d);
  assert.match(flight.d, new RegExp(`L ${LEAD.centerX},${layout.LEAD_BUS_Y}`));
  assert.match(flight.d, new RegExp(`L ${ALICE.centerX},${layout.LEAD_BUS_Y}`));
  assert.ok(flight.d.endsWith(`L ${ALICE.centerX},${layout.MEMBER_TOP}`), flight.d);
  assert.equal(flight.chipY, layout.LEAD_BUS_Y - 10);
});

test("成员 → 队长：同一条 lead bus，方向反过来，标注为汇报", () => {
  const [flight] = formationFlights(message({ from: "alice", to: "team-lead", recipients: ["team-lead"] }), NODES);
  assert.equal(flight.channel, "lead");
  assert.equal(flight.tone, "report");
  assert.ok(flight.d.startsWith(`M ${ALICE.centerX},${layout.MEMBER_TOP}`), flight.d);
  assert.ok(flight.d.endsWith(`L ${LEAD.centerX},${layout.LEAD_FOOT}`), flight.d);
});

test("成员 ↔ 成员：走 peer bus", () => {
  const [flight] = formationFlights(message({ from: "alice", to: "bob", recipients: ["bob"] }), NODES);
  assert.equal(flight.channel, "peer");
  assert.equal(flight.tone, "peer");
  assert.equal(flight.labelKey, "teams.communication.peer");
  assert.ok(flight.d.startsWith(`M ${ALICE.centerX},${layout.MEMBER_FOOT}`), flight.d);
  assert.ok(flight.d.endsWith(`L ${BOB.centerX},${layout.MEMBER_FOOT}`), flight.d);
  assert.equal(flight.chipY, layout.PEER_BUS_Y - 10);
});

test("广播：展开成每个收件人一条，队长发的是派工、成员发的是汇报/同侪", () => {
  const fromLead = formationFlights(message({ kind: "broadcast", to: "*", recipients: ["*"] }), NODES);
  assert.deepEqual(fromLead.map((flight) => flight.channel), ["lead", "lead"]);
  assert.deepEqual(fromLead.map((flight) => flight.tone), ["assignment", "assignment"]);

  const fromAlice = formationFlights(
    message({ from: "alice", to: "*", recipients: ["*"] }),
    NODES,
  );
  const byChannel = Object.fromEntries(fromAlice.map((flight) => [flight.channel, flight.tone]));
  assert.deepEqual(byChannel, { lead: "report", peer: "report" }, "成员广播对队长和同侪都算汇报");
});

test("身份别名：`name@team` 能匹配到成员，找不到发送方就不画", () => {
  const [flight] = formationFlights(message({ from: "team-lead@demo" }), NODES);
  assert.ok(flight);
  assert.equal(formationFlights(message({ from: "ghost" }), NODES).length, 0);
});

test("系统消息走 system 色调；发给自己不画", () => {
  const [flight] = formationFlights(message({ kind: "system", from: "alice", to: "team-lead" }), NODES);
  assert.equal(flight.tone, "system");
  assert.equal(formationFlights(message({ from: "alice", to: "alice" }), NODES).length, 0);
});
