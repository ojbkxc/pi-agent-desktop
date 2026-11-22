import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  abPlan,
  compare,
  latestSession,
  measureRoot,
  measureSteps,
  measureToolResults,
  measureTurns,
  messageChars,
  MIN_TURNS_FOR_COMPARISON,
  planGate,
  presetComparison,
  readRecords,
  segmentRecords,
  summarize,
  summarizeSteps,
  summarizeTools,
  turnsByPreset,
} from "./measure-turns.mjs";

/** One session: header, user turn, two assistant turns, a custom record. */
const SESSION = [
  { type: "session", version: 3, timestamp: "2026-11-22T00:00:00.000Z" },
  {
    type: "message",
    timestamp: "2026-11-22T00:00:01.000Z",
    message: { role: "user", content: "hi" },
  },
  {
    type: "message",
    timestamp: "2026-11-22T00:00:11.000Z",
    message: {
      role: "assistant",
      usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100 },
    },
  },
  {
    type: "message",
    timestamp: "2026-11-22T00:00:41.000Z",
    message: {
      role: "assistant",
      usage: { input: 200, output: 900, cacheRead: 4000, cacheWrite: 0, totalTokens: 5100 },
    },
  },
  { type: "custom", timestamp: "2026-11-22T00:00:45.000Z", customType: "note" },
]
  .map((record) => JSON.stringify(record))
  .join("\n");

function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-measure-"));
  const nested = join(dir, "project");
  mkdirSync(nested, { recursive: true });
  return {
    dir,
    nested,
    write: (name, contents) => {
      const path = join(nested, name);
      writeFileSync(path, contents);
      return path;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("turns measure from the previous record, user turns included", () => {
  const turns = measureTurns(readRecords(SESSION));
  assert.equal(turns.length, 2, "only assistant messages with usage are turns");
  assert.equal(turns[0].seconds, 10, "header → first assistant reply");
  assert.equal(turns[1].seconds, 30, "first reply → second reply");
  assert.equal(turns[1].output, 900);
  assert.equal(turns[1].cacheRead, 4000);
});

test("a truncated last line is skipped, not thrown", () => {
  assert.equal(readRecords(`${SESSION}\n{"type":"message",`).length, 5);
});

test("numbers a turn cannot have are zero, never NaN", () => {
  const turns = measureTurns([
    { type: "message", timestamp: "2026-11-22T00:00:00.000Z" },
    { type: "message", timestamp: "2026-11-22T00:00:05.000Z", message: { role: "assistant", usage: {} } },
  ]);
  assert.equal(turns[0].output, 0);
  assert.equal(turns[0].input, 0);
});

test("the summary reports the three numbers a change has to move", () => {
  const summary = summarize(measureTurns(readRecords(SESSION)));
  assert.equal(summary.turns, 2);
  assert.equal(summary.output, 1000);
  assert.equal(summary.cacheRead, 4000);
  assert.equal(summary.medianTurnSeconds, 10, "median of [10, 30] takes the lower bound");
  assert.equal(summary.p90TurnSeconds, 30);
  assert.equal(summary.outputTokensPerSecond, 33.3, "1000 tokens over the 30s measured span");
});

test("finds sessions recursively and honours --since", () => {
  const root = tempRoot();
  try {
    root.write("a.jsonl", SESSION);
    const all = measureRoot(root.dir);
    assert.equal(all.sessions.length, 1);
    assert.equal(all.total.output, 1000);
    const none = measureRoot(root.dir, { since: "2026-11-23T00:00:00.000Z" });
    assert.equal(none.sessions.length, 0);
    assert.equal(none.total.turns, 0);
  } finally {
    root.cleanup();
  }
});

test("an unparsable --since is refused instead of silently measuring everything", () => {
  const root = tempRoot();
  try {
    assert.throws(() => measureRoot(root.dir, { since: "yesterday" }), /not a timestamp/);
  } finally {
    root.cleanup();
  }
});

test("an empty root is a zero summary, not a crash", () => {
  const root = tempRoot();
  try {
    const result = measureRoot(join(root.dir, "missing"));
    assert.deepEqual(result.sessions, []);
    assert.equal(result.total.turns, 0);
    assert.equal(result.total.outputTokensPerSecond, 0);
    assert.equal(latestSession(join(root.dir, "missing")), null, "no session is null, not an empty report");
  } finally {
    root.cleanup();
  }
});

test("the latest session is the newest file, and carries the per-preset split", () => {
  const root = tempRoot();
  try {
    root.write("old.jsonl", SESSION);
    // A newer session: one standard run, then an off run.
    const newer = [
      { type: "session", timestamp: "2026-11-23T00:00:00.000Z" },
      { type: "custom", customType: "pi-web:fast-mode", timestamp: "2026-11-23T00:00:01.000Z", data: { preset: "standard" } },
      { type: "message", timestamp: "2026-11-23T00:00:11.000Z", message: { role: "assistant", usage: { input: 10, output: 200 } } },
      { type: "custom", customType: "pi-web:fast-mode", timestamp: "2026-11-23T00:00:20.000Z", data: { preset: "off" } },
      { type: "message", timestamp: "2026-11-23T00:00:40.000Z", message: { role: "assistant", usage: { input: 10, output: 300 } } },
    ].map((record) => JSON.stringify(record)).join("\n");
    root.write("new.jsonl", newer);

    const latest = latestSession(root.dir);
    assert.ok(latest.file.endsWith("new.jsonl"), "newest file wins");
    assert.equal(latest.turns.turns, 2);
    assert.equal(latest.turns.output, 500);
    assert.deepEqual(Object.keys(latest.byPreset), ["standard", "off"]);
    assert.equal(latest.byPreset.off.output, 300);
  } finally {
    root.cleanup();
  }
});

// compare() decides a before/after, so these pin the three ways it can be wrong:
// calling noise a result, hiding an output blow-up behind a faster median, and
// missing a cache regression that only shows up in the token mix.
function summaryFor({ turns, median, output, input = 1000, cacheRead = 4000 }) {
  return {
    turns,
    output,
    input,
    cacheRead,
    cacheWrite: 0,
    totalTokens: output + input + cacheRead,
    spanSeconds: turns * median,
    medianTurnSeconds: median,
    p90TurnSeconds: median * 2,
    outputTokensPerSecond: 0,
  };
}

test("fewer than the minimum turns on either side is not a result, and says how far off it is", () => {
  const verdict = compare(
    summaryFor({ turns: 5, median: 30, output: 6000 }),
    summaryFor({ turns: 40, median: 10, output: 4000 }),
  );
  assert.equal(verdict.conclusion, "insufficient");
  assert.equal(verdict.minTurns, MIN_TURNS_FOR_COMPARISON);
  assert.deepEqual(verdict.shortfall, { before: 1, after: 0 }, "one more turn on the baseline side");
});

test("a clear median drop over enough turns reads as faster", () => {
  const verdict = compare(
    summaryFor({ turns: 10, median: 30, output: 6000 }),
    summaryFor({ turns: 10, median: 18, output: 3600 }),
  );
  assert.equal(verdict.conclusion, "faster");
  assert.equal(verdict.medianTurnSeconds.deltaPercent, -40);
  assert.equal(verdict.outputPerTurn.after, 360);
  assert.equal(verdict.outputPerTurn.deltaPercent, -40);
});

test("faster but writing more is mixed, not a win", () => {
  const verdict = compare(
    summaryFor({ turns: 10, median: 30, output: 3000 }),
    summaryFor({ turns: 10, median: 18, output: 6000 }),
  );
  assert.equal(verdict.conclusion, "mixed");
  assert.ok(verdict.outputPerTurn.deltaPercent > 15);
});

test("slower but writing much less is mixed, not a loss", () => {
  const verdict = compare(
    summaryFor({ turns: 10, median: 20, output: 8000 }),
    summaryFor({ turns: 10, median: 34, output: 3000 }),
  );
  assert.equal(verdict.conclusion, "mixed");
});

test("a flat median with less output is leaner, not faster", () => {
  const verdict = compare(
    summaryFor({ turns: 10, median: 20, output: 8000 }),
    summaryFor({ turns: 10, median: 20, output: 4000 }),
  );
  assert.equal(verdict.conclusion, "leaner");
  assert.equal(verdict.medianTurnSeconds.deltaPercent, 0);
  assert.equal(verdict.outputPerTurn.deltaPercent, -50);
});

test("a small move is flat, not a win", () => {
  const verdict = compare(
    summaryFor({ turns: 10, median: 30, output: 6000 }),
    summaryFor({ turns: 10, median: 28, output: 6000 }),
  );
  assert.equal(verdict.conclusion, "flat");
});

test("a slower median with roughly the same output reads as slower", () => {
  const verdict = compare(
    summaryFor({ turns: 10, median: 20, output: 8000 }),
    summaryFor({ turns: 10, median: 34, output: 7600 }),
  );
  assert.equal(verdict.conclusion, "slower");
  assert.ok(Math.abs(verdict.outputPerTurn.deltaPercent) < 15);
});

test("the cache share is reported, so a prompt rewrite that missed the cache shows", () => {
  const cached = compare(
    summaryFor({ turns: 10, median: 20, output: 5000, cacheRead: 20000 }),
    { ...summaryFor({ turns: 10, median: 20, output: 5000, cacheRead: 0 }), cacheRead: 0 },
  );
  assert.ok(cached.cacheReadShare.before > 0.7);
  assert.equal(cached.cacheReadShare.after, 0);
});

test("a cache collapse is called out, because it explains a worse median", () => {
  const verdict = compare(
    summaryFor({ turns: 10, median: 20, output: 5000, cacheRead: 20000 }),
    { ...summaryFor({ turns: 10, median: 20, output: 5000, cacheRead: 0 }), cacheRead: 0 },
  );
  assert.ok(verdict.cacheReadShare.deltaPoints <= -20);
  assert.equal(verdict.notes.length, 1);
  assert.match(verdict.notes[0], /缓存命中/);
});

test("a cache gain is noted, and a stable cache says nothing", () => {
  const better = compare(
    { ...summaryFor({ turns: 10, median: 20, output: 5000, cacheRead: 0 }), cacheRead: 0 },
    summaryFor({ turns: 10, median: 20, output: 5000, cacheRead: 30000 }),
  );
  assert.match(better.notes[0] ?? "", /升到/);
  const stable = compare(
    summaryFor({ turns: 10, median: 20, output: 5000 }),
    summaryFor({ turns: 10, median: 20, output: 5000 }),
  );
  assert.deepEqual(stable.notes, []);
});

// The truncation question is answered by these: is tool output a real share of
// what the model reads? These pin the arithmetic that decides it.
function toolRecord(toolName, text, { ms = 0, isError = false } = {}) {
  return JSON.stringify({
    type: "message",
    timestamp: "2026-11-22T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolName,
      durationMs: ms,
      isError,
      content: [{ type: "text", text }],
    },
  });
}

test("tool results are grouped by name with size percentiles", () => {
  const records = readRecords([
    toolRecord("bash", "a".repeat(100), { ms: 1200 }),
    toolRecord("bash", "b".repeat(300), { ms: 800 }),
    toolRecord("read", "c".repeat(50)),
    toolRecord("bash", "", { isError: true }),
  ].join("\n"));
  const summary = summarizeTools(measureToolResults(records), messageChars(records));
  assert.equal(summary.calls, 4);
  assert.equal(summary.tools[0].tool, "bash", "largest total first");
  assert.equal(summary.tools[0].calls, 3);
  assert.equal(summary.tools[0].chars, 400);
  assert.equal(summary.tools[0].errors, 1);
  assert.equal(summary.tools[0].maxChars, 300);
  assert.equal(summary.tools[0].totalMs, 2000);
  assert.equal(summary.tools[1].tool, "read");
});

test("a tool result without a name is counted, not dropped", () => {
  const records = readRecords(JSON.stringify({
    type: "message",
    message: { role: "toolResult", content: "x".repeat(10) },
  }));
  const rows = measureToolResults(records);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool, "unknown");
});

test("the share is tool bytes over every message's bytes", () => {
  const records = readRecords([
    toolRecord("bash", "t".repeat(100)),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "a".repeat(300) }] } }),
  ].join("\n"));
  const summary = summarizeTools(measureToolResults(records), messageChars(records));
  assert.equal(summary.chars, 100);
  assert.ok(summary.shareOfMessageChars > 0 && summary.shareOfMessageChars < 0.5);
});

test("a session with no tool results is a zero summary", () => {
  const summary = summarizeTools([], 0);
  assert.deepEqual(summary.tools, []);
  assert.equal(summary.calls, 0);
  assert.equal(summary.shareOfMessageChars, 0);
});

// Steps decide how many round trips a turn pays. These pin the two facts a
// "fewer steps" change has to move: sibling calls riding together, and the same
// call being issued twice.
function assistantStep(calls) {
  return JSON.stringify({
    type: "message",
    timestamp: "2026-11-22T00:00:00.000Z",
    message: {
      role: "assistant",
      content: calls.map((call, index) => ({
        type: "toolCall",
        id: `c${index}`,
        name: call.name,
        arguments: call.arguments ?? {},
      })),
    },
  });
}

test("sibling calls in one message are one step, not three", () => {
  const records = readRecords([
    assistantStep([{ name: "read" }, { name: "read" }, { name: "grep" }]),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
  ].join("\n"));
  const steps = measureSteps(records);
  assert.equal(steps.length, 1, "a text-only answer is not a tool step");
  assert.equal(steps[0].calls.length, 3);
  const summary = summarizeSteps(steps);
  assert.equal(summary.callsPerStep, 3);
  assert.equal(summary.maxParallel, 3);
  assert.equal(summary.parallelStepShare, 1);
});

test("an identical call repeated later counts as a duplicate, a differing argument does not", () => {
  const summary = summarizeSteps(measureSteps(readRecords([
    assistantStep([{ name: "bash", arguments: { command: "ls" } }]),
    assistantStep([{ name: "bash", arguments: { command: "ls" } }]),
    assistantStep([{ name: "bash", arguments: { command: "pwd" } }]),
  ].join("\n"))));
  assert.equal(summary.steps, 3);
  assert.equal(summary.calls, 3);
  assert.equal(summary.duplicateCalls, 1);
  assert.equal(summary.duplicateShare, 0.33);
  assert.equal(summary.maxParallel, 1);
  assert.equal(summary.parallelStepShare, 0);
});

test("no tool calls is a zero step summary", () => {
  const summary = summarizeSteps(measureSteps([]));
  assert.equal(summary.steps, 0);
  assert.equal(summary.callsPerStep, 0);
  assert.equal(summary.duplicateShare, 0);
});

// --by-preset is what makes a real A/B possible without asking the user to keep
// two separate logs: the transcript already says which preset shaped each turn.
function presetEntry(preset, active = true) {
  // `active` is the legacy second encoding: entries written before the field was
  // dropped carried it. New entries say everything with `preset`.
  const data = active ? { preset, switches: {} } : { preset, switches: {}, active: false };
  return JSON.stringify({
    type: "custom",
    customType: "pi-web:fast-mode",
    timestamp: "2026-11-22T00:00:00.000Z",
    data,
  });
}

test("turns are attributed to the preset recorded before them", () => {
  const records = readRecords([
    JSON.stringify({ type: "session", timestamp: "2026-11-22T00:00:00.000Z" }),
    JSON.stringify({ type: "message", timestamp: "2026-11-22T00:00:01.000Z", message: { role: "assistant", usage: { input: 10, output: 100 } } }),
    presetEntry("standard"),
    JSON.stringify({ type: "message", timestamp: "2026-11-22T00:00:31.000Z", message: { role: "assistant", usage: { input: 10, output: 200 } } }),
    presetEntry("off", false),
    JSON.stringify({ type: "message", timestamp: "2026-11-22T00:01:01.000Z", message: { role: "assistant", usage: { input: 10, output: 400 } } }),
  ].join("\n"));
  const groups = turnsByPreset(records);
  assert.deepEqual([...groups.keys()], ["unrecorded", "standard", "off"]);
  assert.equal(groups.get("unrecorded").output, 100);
  assert.equal(groups.get("standard").output, 200);
  assert.equal(groups.get("off").output, 400);
  assert.equal(groups.get("off").turns, 1);
});

test("an entry that only repeats the same preset does not split the group", () => {
  const records = readRecords([
    presetEntry("standard"),
    JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1, output: 10 } } }),
    presetEntry("standard"),
    JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1, output: 20 } } }),
  ].join("\n"));
  const groups = turnsByPreset(records);
  assert.equal(groups.size, 1);
  assert.equal(groups.get("standard").turns, 2);
  assert.equal(groups.get("standard").output, 30);
});

test("an entry with only a preset is understood; a legacy active:false still means off", () => {
  const modern = readRecords([
    presetEntry("standard"),
    JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1, output: 10 } } }),
    presetEntry("off"),
    JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1, output: 20 } } }),
  ].join("\n"));
  assert.deepEqual([...turnsByPreset(modern).keys()], ["standard", "off"]);

  const legacy = readRecords([
    presetEntry("standard", false),
    JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1, output: 10 } } }),
  ].join("\n"));
  assert.deepEqual([...turnsByPreset(legacy).keys()], ["off"], "old entries keep their meaning");
});

// --ab is the payoff: with two recorded presets it answers the question the
// whole feature exists for, without asking the user to keep a separate log.
function groupOf(turns, median, output) {
  return summaryFor({ turns, median, output });
}

test("off is the baseline and standard the treatment when both are recorded", () => {
  const result = presetComparison(new Map([
    ["standard", groupOf(9, 12, 2700)],
    ["off", groupOf(9, 24, 6300)],
  ]));
  assert.equal(result.baseline, "off");
  assert.equal(result.treatment, "standard");
  assert.equal(result.verdict.conclusion, "faster");
  assert.equal(result.verdict.medianTurnSeconds.deltaPercent, -50);
});

test("unrecorded turns never enter the comparison", () => {
  const result = presetComparison(new Map([
    ["unrecorded", groupOf(40, 5, 1000)],
    ["off", groupOf(9, 24, 6300)],
    ["standard", groupOf(9, 12, 2700)],
  ]));
  assert.equal(result.baseline, "off");
  assert.equal(result.treatment, "standard");
});

test("one recorded preset is not a comparison, and says why", () => {
  const result = presetComparison(new Map([["standard", groupOf(9, 12, 2700)]]));
  assert.equal(result.verdict, null);
  assert.match(result.reason, /at least two presets/);
});

test("two presets without off and standard still compare the two largest groups", () => {
  const result = presetComparison(new Map([
    ["conservative", groupOf(8, 20, 4000)],
    ["off", groupOf(3, 22, 5000)],
  ]));
  assert.equal(result.baseline, "off");
  assert.equal(result.treatment, "conservative");
  assert.equal(result.verdict.conclusion, "insufficient", "3 turns on the baseline side");
});

test("segments carry the records each preset actually shaped", () => {
  const records = readRecords([
    JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1, output: 10 } } }),
    presetEntry("standard"),
    JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1, output: 20 } } }),
    presetEntry("off", false),
    JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1, output: 30 } } }),
  ].join("\n"));
  const segments = segmentRecords(records);
  assert.deepEqual(segments.map((segment) => segment.preset), ["unrecorded", "standard", "off"]);
  assert.equal(segments[1].records.length, 1, "the entry itself belongs to no segment");
  assert.equal(segments[2].records.length, 1);
});

test("tools and steps can be summarised per preset from the same segments", () => {
  const records = readRecords([
    presetEntry("standard"),
    toolRecord("bash", "x".repeat(100)),
    assistantStep([{ name: "read" }, { name: "grep" }]),
    presetEntry("off", false),
    toolRecord("bash", "y".repeat(400)),
    assistantStep([{ name: "read" }]),
  ].join("\n"));
  const byPreset = segmentRecords(records)
    .filter((segment) => segment.preset !== "unrecorded")
    .map((segment) => ({
      preset: segment.preset,
      tools: summarizeTools(measureToolResults(segment.records), messageChars(segment.records)),
      steps: summarizeSteps(measureSteps(segment.records)),
    }));
  const standard = byPreset.find((row) => row.preset === "standard");
  const off = byPreset.find((row) => row.preset === "off");
  assert.equal(standard.tools.chars, 100);
  assert.equal(standard.steps.maxParallel, 2, "two sibling calls under standard");
  assert.equal(off.tools.chars, 400);
  assert.equal(off.steps.maxParallel, 1);
});







test("the plan says which side is short and by how many turns", () => {
  const plan = abPlan(new Map([
    ["off", groupOf(6, 24, 6000)],
    ["standard", groupOf(2, 12, 1800)],
  ]));
  assert.equal(plan.turns.off, 6);
  assert.equal(plan.turns.standard, 2);
  assert.equal(plan.ready, false);
  assert.match(plan.steps[0], /不用再跑/, "the baseline side is complete");
  assert.match(plan.steps[1], /切到「标准」.*4 轮/, "the treatment side names its gap");
});

test("with no data at all the plan starts from the baseline", () => {
  const plan = abPlan(new Map());
  assert.equal(plan.turns.off, 0);
  assert.equal(plan.missing.off, MIN_TURNS_FOR_COMPARISON);
  assert.match(plan.steps[0], /切到「关闭」/);
  assert.equal(plan.ready, false);
});

test("both sides complete means the only step left is the verdict", () => {
  const plan = abPlan(new Map([
    ["off", groupOf(8, 24, 6000)],
    ["standard", groupOf(9, 12, 2700)],
  ]));
  assert.equal(plan.ready, true);
  assert.match(plan.steps[0], /基线已够/);
  assert.match(plan.steps[1], /处理组已够/);
  assert.match(plan.steps[2], /--ab/);
});

test("unrecorded turns do not count toward either side", () => {
  const plan = abPlan(new Map([
    ["unrecorded", groupOf(50, 20, 9000)],
    ["standard", groupOf(6, 12, 1800)],
  ]));
  assert.equal(plan.turns.off, 0, "history without a breadcrumb is not a baseline");
  assert.equal(plan.turns.standard, 6);
  assert.equal(plan.ready, false);
});

test("the off entry is load-bearing: without it, later turns are misattributed", () => {
  // Hypothesis worth checking before deleting it as "noise": the entry written when fast
  // mode is switched off is the boundary that makes --by-preset correct. A transcript
  // with the switch but no entry would credit those turns to the previous preset.
  const message = JSON.stringify({
    type: "message",
    timestamp: "2026-11-22T00:00:00.000Z",
    message: { role: "assistant", usage: { input: 10, output: 100 } },
  });
  const withEntry = readRecords([
    presetEntry("standard"),
    message,
    presetEntry("off"),
    message,
  ].join("\n"));
  assert.deepEqual([...turnsByPreset(withEntry).keys()], ["standard", "off"]);

  const withoutEntry = readRecords([
    presetEntry("standard"),
    message,
    message,
  ].join("\n"));
  assert.deepEqual(
    [...turnsByPreset(withoutEntry).keys()],
    ["standard"],
    "without the boundary every later turn is still counted as standard",
  );
  assert.equal(turnsByPreset(withoutEntry).get("standard").turns, 2);
});

test("an unrun feature is not measured: the gate stops the plan", () => {
  const blocked = planGate({ entries: 0, steps: ["1. 重启", "2. 发一轮", "3. 复查"], lastSessionAt: null });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.lines[0], /尚无使用证据/);
  assert.equal(blocked.lines.length, 4, "the three restart steps ride along");

  const running = planGate({ entries: 3, steps: [], lastSessionAt: "2026-11-22T00:00:00.000Z" });
  assert.equal(running.blocked, false);
  assert.match(running.lines[0], /3 条/);

  assert.deepEqual(planGate(null), { blocked: false, lines: [] }, "no live info means no gate");
});
