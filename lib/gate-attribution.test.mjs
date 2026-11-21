/**
 * The recorder's own rules: it appends, it is bounded, and it never authors a
 * verdict.
 *
 * The last test is a source invariant on purpose. "Recording a gate must not
 * change the gate" is not provable from the runtime alone — the way it breaks is
 * someone turning the recorder into a lookup. So the module is checked for the
 * shape that would make that possible: a boolean-returning function, or an
 * export that reads the ring back into a decision.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const {
  GATE_EVENT_MAX,
  GATE_LAYERS,
  clearGateEvents,
  gateAttribution,
  gateSnapshot,
  recordGate,
} = await import("./gate-attribution.ts");

test("a recorder appends what the gate answered and returns nothing", () => {
  clearGateEvents();
  assert.equal(recordGate({ layer: "tool-approval", decision: "denied", reason: "rejected" }), undefined);
  const events = gateSnapshot();
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.layer, "tool-approval");
  assert.equal(event.decision, "denied");
  assert.equal(event.reason, "rejected");
  assert.equal(typeof event.at, "number");
});

test("an event without a reason carries no reason key", () => {
  clearGateEvents();
  recordGate({ layer: "model", decision: "allowed" });
  assert.equal("reason" in gateSnapshot()[0], false);
});

test("the ring is bounded and drops the oldest", () => {
  clearGateEvents();
  for (let i = 0; i < GATE_EVENT_MAX + 7; i += 1) {
    recordGate({ layer: "model", decision: "allowed" });
  }
  assert.equal(gateSnapshot().length, GATE_EVENT_MAX);
});

test("a snapshot is a copy: mutating it leaves the ring alone", () => {
  clearGateEvents();
  recordGate({ layer: "project-trust", decision: "denied", reason: "not-trusted" });
  const events = gateSnapshot();
  events[0].decision = "allowed";
  events.push({ at: 0, layer: "model", decision: "allowed" });
  assert.equal(gateSnapshot().length, 1);
  assert.equal(gateSnapshot()[0].decision, "denied");
});

test("attribution counts every layer and keeps the verdicts apart", () => {
  clearGateEvents();
  recordGate({ layer: "tool-approval", decision: "denied", reason: "rejected" });
  recordGate({ layer: "tool-approval", decision: "allowed", reason: "confirmed" });
  recordGate({ layer: "mcp-trust", decision: "denied", reason: "not-trusted" });

  const { byLayer, byDecision } = gateAttribution();
  assert.deepEqual(Object.keys(byLayer).sort(), [...GATE_LAYERS].sort());
  assert.equal(byLayer["tool-approval"], 2);
  assert.equal(byLayer["mcp-trust"], 1);
  assert.equal(byLayer["permission-gate"], 0);
  assert.equal(byDecision.denied, 2);
  assert.equal(byDecision.allowed, 1);
  assert.equal(byDecision.denied + byDecision.allowed, gateSnapshot().length);
});

test("the module exposes no way to author a verdict", () => {
  const source = readFileSync(join(here, "gate-attribution.ts"), "utf8");
  assert.match(
    source,
    /export function recordGate\(event: \{[^}]*\}\): void \{/,
    "recordGate must stay void: a caller must not be able to branch on the write",
  );
  for (const name of ["allow", "permit", "bypass", "decide", "should"]) {
    assert.ok(
      !new RegExp(`export function ${name}\\b`).test(source),
      `gate-attribution must not export ${name}(): that would make it a gate, not a record`,
    );
  }
});
