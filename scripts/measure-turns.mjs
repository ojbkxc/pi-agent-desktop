#!/usr/bin/env node
/**
 * What a turn actually costs, from the session logs on this machine.
 *
 * The fast-mode switches and the reasoning level are guesses until something
 * measures them. A pi session file is JSONL with one `message` record per
 * turn, and every assistant message carries `usage`; the timestamp gap between
 * two messages is the wall clock that turn took (model round trip + tool
 * execution + the next request's prefill). This script turns those files into
 * the three numbers that decide whether a change was worth it:
 *
 *   output tokens  → decode time, the thing a brevity rule attacks
 *   turn seconds   → round trips, the thing fewer steps attacks
 *   cacheRead      → how much of the prompt was free, the thing a prompt
 *                    rewrite breaks
 *
 * Usage:
 *   node scripts/measure-turns.mjs                       # every session, all time
 *   node scripts/measure-turns.mjs --since 2026-11-22T00:00:00Z
 *   node scripts/measure-turns.mjs --compare 2026-11-22T00:00:00Z   # before/after verdict
 *   node scripts/measure-turns.mjs --tools               # tool-result size baseline
 *   node scripts/measure-turns.mjs --root <dir> --json
 *
 * It reads only. Nothing here writes, and no network or model call is made.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { liveReport } from "./fast-mode-live.mjs";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every `.jsonl` under `root`, recursive; unreadable directories are skipped. */
function findSessionFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl")) out.push(path);
    }
  };
  walk(root);
  return out;
}

/** Parsed records, tolerating a truncated last line. */
export function readRecords(text) {
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A session file being written right now can end mid-line.
    }
  }
  return records;
}

function numberOf(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Assistant turns with a usage block, each carrying the seconds since the
 * previous record (the first one measures from the session header).
 */
export function measureTurns(records) {
  const turns = [];
  let previous = undefined;
  for (const record of records) {
    const at = Date.parse(record?.timestamp ?? "");
    if (!Number.isFinite(at)) continue;
    const message = isRecord(record.message) ? record.message : undefined;
    const usage = message && isRecord(message.usage) ? message.usage : undefined;
    if (message?.role === "assistant" && usage) {
      const seconds = previous === undefined ? 0 : Math.max(0, (at - previous) / 1000);
      turns.push({
        at,
        seconds,
        input: numberOf(usage.input),
        output: numberOf(usage.output),
        cacheRead: numberOf(usage.cacheRead),
        cacheWrite: numberOf(usage.cacheWrite),
        totalTokens: numberOf(usage.totalTokens),
      });
    }
    previous = at;
  }
  return turns;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

/** The summary a before/after comparison reads. */
export function summarize(turns) {
  const sum = (key) => turns.reduce((total, turn) => total + turn[key], 0);
  const span = turns.length ? turns[turns.length - 1].at - turns[0].at : 0;
  const seconds = turns.map((turn) => turn.seconds);
  const output = sum("output");
  return {
    turns: turns.length,
    output,
    input: sum("input"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    totalTokens: sum("totalTokens"),
    spanSeconds: Math.round(span / 1000),
    medianTurnSeconds: Number(percentile(seconds, 0.5).toFixed(1)),
    p90TurnSeconds: Number(percentile(seconds, 0.9).toFixed(1)),
    // Decode throughput over the measured span: the number a brevity rule moves.
    outputTokensPerSecond: span > 0 ? Number((output / (span / 1000)).toFixed(1)) : 0,
  };
}

function format(summary) {
  return [
    `turns ${summary.turns}`,
    `output ${summary.output}`,
    `input ${summary.input}`,
    `cacheRead ${summary.cacheRead}`,
    `span ${summary.spanSeconds}s`,
    `median turn ${summary.medianTurnSeconds}s`,
    `p90 turn ${summary.p90TurnSeconds}s`,
    `out tok/s ${summary.outputTokensPerSecond}`,
  ].join(" | ");
}

/** Below this many turns per side, a difference is noise, not a result. */
export const MIN_TURNS_FOR_COMPARISON = 6;

/**
 * Tool results, as the transcript records them: role `toolResult` with a
 * `toolName`, a `content` array and a `durationMs`.
 *
 * This exists to answer one question before anyone builds a truncator: is tool
 * output actually a large share of what the model reads, or is it noise beside
 * the assistant's own answer? Guessing wrong costs a feature nobody turns on.
 */
/** Characters the model reads from a message's content: text parts only, no JSON scaffolding. */
function contentChars(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "").length;
  let total = 0;
  for (const part of content) {
    if (typeof part === "string") total += part.length;
    else if (part && typeof part.text === "string") total += part.text.length;
    else if (part && typeof part.type === "string" && part.type !== "text") total += JSON.stringify(part).length;
  }
  return total;
}

export function measureToolResults(records) {
  const rows = [];
  for (const record of records) {
    const message = isRecord(record?.message) ? record.message : undefined;
    if (message?.role !== "toolResult") continue;
    rows.push({
      tool: typeof message.toolName === "string" && message.toolName ? message.toolName : "unknown",
      chars: contentChars(message.content),
      ms: typeof message.durationMs === "number" ? message.durationMs : 0,
      isError: message.isError === true,
    });
  }
  return rows;
}

/** Per-tool counts, size percentiles and the share of all message bytes they take. */
export function summarizeTools(rows, allChars) {
  const byTool = new Map();
  for (const row of rows) {
    const bucket = byTool.get(row.tool) ?? { tool: row.tool, calls: 0, chars: 0, ms: 0, errors: 0, sizes: [] };
    bucket.calls += 1;
    bucket.chars += row.chars;
    bucket.ms += row.ms;
    if (row.isError) bucket.errors += 1;
    bucket.sizes.push(row.chars);
    byTool.set(row.tool, bucket);
  }
  const tools = [...byTool.values()]
    .map((bucket) => ({
      tool: bucket.tool,
      calls: bucket.calls,
      chars: bucket.chars,
      medianChars: percentile(bucket.sizes, 0.5),
      p90Chars: percentile(bucket.sizes, 0.9),
      maxChars: Math.max(...bucket.sizes),
      errors: bucket.errors,
      totalMs: bucket.ms,
    }))
    .sort((a, b) => b.chars - a.chars);
  const chars = rows.reduce((total, row) => total + row.chars, 0);
  return {
    tools,
    calls: rows.length,
    chars,
    shareOfMessageChars: allChars > 0 ? Number((chars / allChars).toFixed(3)) : 0,
  };
}

/** Every message's readable length in characters, for the share denominator. */
export function messageChars(records) {
  let total = 0;
  for (const record of records) {
    const message = isRecord(record?.message) ? record.message : undefined;
    if (!message || typeof message.role !== "string") continue;
    total += contentChars(message.content);
  }
  return total;
}

/**
 * Records split at every preset change, so one pass can answer "under which
 * preset" for turns, tools and steps alike. `unrecorded` is everything before
 * the first entry — the honest answer for sessions that predate the feature.
 */
export function segmentRecords(records) {
  const segments = [];
  let current = "unrecorded";
  let bucket = [];
  for (const record of records) {
    if (record?.type === "custom" && record.customType === "pi-web:fast-mode") {
      const data = isRecord(record.data) ? record.data : {};
      // `preset` is the whole story. `active: false` is honoured for entries written
      // before that was true (they carried both fields); anything else is `unrecorded`.
      const preset = typeof data.preset === "string" ? data.preset : "unrecorded";
      const next = data.active === false ? "off" : preset;
      if (next !== current) {
        if (bucket.length) segments.push({ preset: current, records: bucket });
        bucket = [];
        current = next;
      }
      continue;
    }
    bucket.push(record);
  }
  if (bucket.length) segments.push({ preset: current, records: bucket });
  return segments;
}

/**
 * The preset that shaped each assistant turn, read from the transcript entries
 * fast mode writes on a change (`pi-web:fast-mode`, see
 * lib/fast-mode/extension.ts). Turns before any entry are `unrecorded`, which is
 * the honest answer for every session from before the feature existed.
 */
export function turnsByPreset(records) {
  const groups = new Map();
  for (const segment of segmentRecords(records)) {
    const turns = groups.get(segment.preset) ?? [];
    for (const record of segment.records) {
      const message = isRecord(record?.message) ? record.message : undefined;
      if (message?.role !== "assistant" || !isRecord(message.usage)) continue;
      turns.push({
        at: Date.parse(record?.timestamp ?? "") || 0,
        seconds: 0,
        input: numberOf(message.usage.input),
        output: numberOf(message.usage.output),
        cacheRead: numberOf(message.usage.cacheRead),
        cacheWrite: numberOf(message.usage.cacheWrite),
        totalTokens: numberOf(message.usage.totalTokens),
      });
    }
    // A segment with no assistant turn (the session header, a lone entry) is not a
    // group: it would show up in --by-preset as a zero row and in --ab as a preset.
    if (turns.length) groups.set(segment.preset, turns);
  }
  for (const turns of groups.values()) {
    for (let index = 1; index < turns.length; index += 1) {
      turns[index].seconds = Math.max(0, (turns[index].at - turns[index - 1].at) / 1000);
    }
  }
  return new Map([...groups.entries()].map(([preset, turns]) => [preset, summarize(turns)]));
}

/**
 * The A/B verdict between two recorded presets.
 *
 * Picks `off` as the baseline and `standard` as the treatment when both are
 * present, otherwise the two groups with the most turns; anything else is not a
 * comparison. `unrecorded` never enters — those turns predate the breadcrumb and
 * may have run under any preset.
 */
export function presetComparison(groups) {
  const recorded = [...groups.entries()].filter(([preset]) => preset !== "unrecorded");
  if (recorded.length < 2) {
    return {
      verdict: null,
      reason: `need turns under at least two presets, have ${recorded.length ? recorded.map(([preset]) => preset).join(", ") : "none"}`,
    };
  }
  const byName = new Map(recorded);
  const ranked = [...recorded].sort((a, b) => b[1].turns - a[1].turns);
  const baselineName = byName.has("off") ? "off" : ranked[0][0];
  const treatmentName = byName.has("standard") && baselineName !== "standard"
    ? "standard"
    : (ranked.find(([preset]) => preset !== baselineName)?.[0] ?? ranked[1][0]);
  return {
    baseline: baselineName,
    treatment: treatmentName,
    verdict: compare(byName.get(baselineName), byName.get(treatmentName)),
  };
}

/**
 * The most recently modified session, with the same summaries as the whole
 * library. "How is this preset doing right now" is a per-session question:
 * pooled numbers hide a fresh run behind months of history.
 */
export function latestSession(root) {
  const files = findSessionFiles(root)
    .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { file, mtime } of files) {
    let records;
    try {
      records = readRecords(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const turns = summarize(measureTurns(records));
    if (turns.turns === 0 && records.length === 0) continue;
    const allChars = messageChars(records);
    return {
      file,
      modified: new Date(mtime).toISOString(),
      turns,
      byPreset: Object.fromEntries(turnsByPreset(records)),
      tools: summarizeTools(measureToolResults(records), allChars),
      steps: summarizeSteps(measureSteps(records)),
    };
  }
  return null;
}

/**
 * What to do next, in the order that produces a verdict.
 *
 * The measurement is only useful if someone runs the two arms; this turns the
 * gap into instructions: which preset to switch to, how many turns are still
 * missing on each side, and which command answers the question afterwards.
 */
export function abPlan(groups) {
  const recorded = new Map([...groups.entries()].filter(([preset]) => preset !== "unrecorded"));
  const baseline = "off";
  const treatment = "standard";
  const turnsOf = (preset) => recorded.get(preset)?.turns ?? 0;
  const steps = [];
  const missing = (preset) => Math.max(0, MIN_TURNS_FOR_COMPARISON - turnsOf(preset));

  if (missing(baseline) > 0) {
    steps.push(`1. 设置页把快速模式切到「关闭」，再正常干 ${missing(baseline)} 轮以上的活`);
  } else {
    steps.push(`1. 基线已够（off ${turnsOf(baseline)} 轮），不用再跑`);
  }
  if (missing(treatment) > 0) {
    steps.push(`2. 切到「标准」，再干 ${missing(treatment)} 轮以上的活`);
  } else {
    steps.push(`2. 处理组已够（standard ${turnsOf(treatment)} 轮），不用再跑`);
  }
  steps.push("3. 跑 `node scripts/measure-turns.mjs --ab`，看 median turn 与 output/turn 两行");
  return {
    baseline,
    treatment,
    turns: { off: turnsOf(baseline), standard: turnsOf(treatment) },
    missing: { off: missing(baseline), standard: missing(treatment) },
    ready: missing(baseline) === 0 && missing(treatment) === 0,
    steps,
  };
}

/**
 * Whether an A/B plan is worth starting yet.
 *
 * Planning turns under two presets is pointless when the extension has never run:
 * the settings file says what would happen, not that anything did. The gate says
 * restart first, so the user does not spend six turns measuring a no-op.
 */
export function planGate(live) {
  if (!live) return { blocked: false, lines: [] };
  if (live.entries > 0) {
    return { blocked: false, lines: [`证据：${live.entries} 条 pi-web:fast-mode 记录（最近 ${live.lastSessionAt ?? "未知"}）`] };
  }
  return {
    blocked: true,
    lines: ["尚无使用证据：宿主还没加载这段代码，先按下面三步做完再攒轮次", ...live.steps],
  };
}

/** Tool calls per assistant step, and whether independent calls rode together.
 *
 * Pi executes sibling tool calls from one assistant message concurrently, so a
 * step that issues three independent lookups costs one round trip while three
 * steps cost three — each with its own prefill and gateway latency. This
 * measures how serial a workload actually is before anyone "optimizes" it.
 */
export function measureSteps(records) {
  const steps = [];
  for (const record of records) {
    const message = isRecord(record?.message) ? record.message : undefined;
    if (message?.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const calls = content
      .filter((part) => isRecord(part) && part.type === "toolCall")
      .map((part) => ({
        name: typeof part.name === "string" ? part.name : "unknown",
        key: `${typeof part.name === "string" ? part.name : "unknown"}\u0000${JSON.stringify(part.arguments ?? {})}`,
      }));
    if (calls.length === 0) continue;
    steps.push({ at: Date.parse(record.timestamp ?? "") || 0, calls });
  }
  return steps;
}

/** Serial vs parallel steps, and how often the same call is repeated. */
export function summarizeSteps(steps) {
  const calls = steps.reduce((total, step) => total + step.calls.length, 0);
  const seen = new Map();
  let duplicates = 0;
  for (const step of steps) {
    for (const call of step.calls) {
      const count = seen.get(call.key) ?? 0;
      if (count > 0) duplicates += 1;
      seen.set(call.key, count + 1);
    }
  }
  const parallelSteps = steps.filter((step) => step.calls.length > 1).length;
  return {
    steps: steps.length,
    calls,
    callsPerStep: steps.length ? Number((calls / steps.length).toFixed(2)) : 0,
    maxParallel: steps.reduce((max, step) => Math.max(max, step.calls.length), 0),
    parallelStepShare: steps.length ? Number((parallelSteps / steps.length).toFixed(2)) : 0,
    duplicateCalls: duplicates,
    duplicateShare: calls ? Number((duplicates / calls).toFixed(2)) : 0,
  };
}

function ratio(before, after) {
  if (!before) return after ? Infinity : 1;
  return Number((after / before).toFixed(3));
}

/**
 * A before/after verdict over two summaries.
 *
 * Decides on median turn seconds (what a user feels) and reports output per
 * turn plus the cache-read share beside it, because a "faster" turn that
 * doubled the output is not a win and a rewritten prompt that dropped the
 * cache is the usual reason a change looks slower than it is.
 */
export function compare(before, after) {
  const outputPerTurnBefore = before.turns ? before.output / before.turns : 0;
  const outputPerTurnAfter = after.turns ? after.output / after.turns : 0;
  const cacheShareBefore = before.turns + before.cacheRead
    ? Number((before.cacheRead / (before.cacheRead + before.input + before.output)).toFixed(3))
    : 0;
  const cacheShareAfter = after.turns + after.cacheRead
    ? Number((after.cacheRead / (after.cacheRead + after.input + after.output)).toFixed(3))
    : 0;
  const medianRatio = ratio(before.medianTurnSeconds, after.medianTurnSeconds);
  const delta = Number(((medianRatio - 1) * 100).toFixed(0));
  const outputDelta = outputPerTurnBefore
    ? Number((((outputPerTurnAfter / outputPerTurnBefore) - 1) * 100).toFixed(0))
    : 0;
  const measured = Math.min(before.turns, after.turns) >= MIN_TURNS_FOR_COMPARISON;
  // Latency is the primary signal; output per turn is the second one that a brevity
  // change is supposed to move. Fast + more output is not a win, and slower + less
  // output is not a loss — both are `mixed`, so neither hides behind one number.
  let conclusion = "insufficient";
  if (measured) {
    if (delta <= -15 && outputDelta >= 15) conclusion = "mixed";
    else if (delta >= 15 && outputDelta <= -15) conclusion = "mixed";
    else if (delta <= -15) conclusion = "faster";
    else if (delta >= 15) conclusion = "slower";
    else if (outputDelta <= -15) conclusion = "leaner";
    else conclusion = "flat";
  }
  const cachePointsBefore = Number((cacheShareBefore * 100).toFixed(0));
  const cachePointsAfter = Number((cacheShareAfter * 100).toFixed(0));
  const cacheDeltaPoints = cachePointsAfter - cachePointsBefore;
  // A rewrite that breaks the prompt prefix shows up here first: the median gets worse
  // without the output changing, and nothing else in the report explains why.
  const notes = [];
  // Only attributed when there is a verdict to explain: a note under `insufficient`
  // invites reading a cache change into numbers that are not measured yet.
  if (measured && cacheDeltaPoints <= -20) {
    notes.push(
      `缓存命中从 ${cachePointsBefore}% 掉到 ${cachePointsAfter}%：多出的 prefill 很可能吃掉了收益，先检查这次改动是否改了提示词前缀`,
    );
  } else if (measured && cacheDeltaPoints >= 20) {
    notes.push(`缓存命中从 ${cachePointsBefore}% 升到 ${cachePointsAfter}%：同样的时间数字更可信`);
  }
  return {
    conclusion,
    medianTurnSeconds: { before: before.medianTurnSeconds, after: after.medianTurnSeconds, deltaPercent: delta },
    outputPerTurn: {
      before: Number(outputPerTurnBefore.toFixed(1)),
      after: Number(outputPerTurnAfter.toFixed(1)),
      deltaPercent: outputDelta,
    },
    cacheReadShare: { before: cacheShareBefore, after: cacheShareAfter, deltaPoints: cacheDeltaPoints },
    notes,
    turns: { before: before.turns, after: after.turns },
    minTurns: MIN_TURNS_FOR_COMPARISON,
    /** Turns still missing on each side before a verdict is possible. */
    shortfall: {
      before: Math.max(0, MIN_TURNS_FOR_COMPARISON - before.turns),
      after: Math.max(0, MIN_TURNS_FOR_COMPARISON - after.turns),
    },
  };
}

export function measureRoot(root, { since } = {}) {
  const floor = since === undefined ? undefined : Date.parse(since);
  if (since !== undefined && !Number.isFinite(floor)) {
    throw new Error(`--since is not a timestamp: ${since}`);
  }
  const sessions = [];
  for (const file of findSessionFiles(root)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const turns = measureTurns(readRecords(text)).filter(
      (turn) => floor === undefined || turn.at >= floor,
    );
    if (turns.length === 0) continue;
    sessions.push({
      file,
      modified: statSync(file).mtime.toISOString(),
      ...summarize(turns),
    });
  }
  sessions.sort((a, b) => a.modified.localeCompare(b.modified));
  const allTurns = [];
  for (const file of findSessionFiles(root)) {
    try {
      allTurns.push(...measureTurns(readRecords(readFileSync(file, "utf8"))));
    } catch {
      // Ignore files that vanished between the two passes.
    }
  }
  const filtered = allTurns.filter((turn) => floor === undefined || turn.at >= floor);
  return { sessions, total: summarize(filtered) };
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = argValue(process.argv, "--root") ?? join(homedir(), ".pi", "agent", "sessions");
  const since = argValue(process.argv, "--since");
  const json = process.argv.includes("--json");
  let result;
  try {
    result = measureRoot(root, { since });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const compareAt = argValue(process.argv, "--compare");  if (process.argv.includes("--all")) {
    const records = [];
    let allChars = 0;
    for (const file of findSessionFiles(root)) {
      try {
        const parsed = readRecords(readFileSync(file, "utf8"));
        records.push(...parsed);
        allChars += messageChars(parsed);
      } catch {
        // Skip an unreadable session rather than failing the whole report.
      }
    }
    const turns = summarize(measureTurns(records));
    const groups = [...turnsByPreset(records).entries()];
    const tools = summarizeTools(measureToolResults(records), allChars);
    const steps = summarizeSteps(measureSteps(records));
    const ab = presetComparison(new Map(groups));
    if (json) {
      console.log(JSON.stringify({ turns, byPreset: Object.fromEntries(groups), tools, steps, ab }, null, 2));
    } else {
      console.log(`root ${root}\n`);
      console.log(`== turns ==\n${format(turns)}`);
      console.log("\n== by preset ==");
      for (const [preset, summary] of groups) console.log(`${preset.padEnd(12)} ${format(summary)}`);
      console.log(
        `\n== tools ==\n${tools.calls} results | ${tools.chars} chars | ${(tools.shareOfMessageChars * 100).toFixed(1)}% of message chars`,
      );
      console.log(
        `\n== steps ==\nsteps ${steps.steps} | calls ${steps.calls} | calls/step ${steps.callsPerStep}`
          + ` | parallel ${(steps.parallelStepShare * 100).toFixed(0)}% | duplicates ${steps.duplicateCalls}`,
      );
      console.log(`\n== ab ==`);
      if (!ab.verdict) console.log(`不足以判定：${ab.reason}。\n先关掉快速模式跑 6 轮、再开标准跑 6 轮，然后重跑这条命令。`);
      else if (ab.verdict.conclusion === "insufficient") {
        console.log(
          `样本不足：${ab.baseline} 还差 ${ab.verdict.shortfall.before} 轮 / ${ab.treatment} 还差 ${ab.verdict.shortfall.after} 轮。`,
        );
      } else console.log(`${ab.baseline} → ${ab.treatment}: ${ab.verdict.conclusion} (median ${ab.verdict.medianTurnSeconds.deltaPercent}%)`);
      const latest = latestSession(root);
      console.log(`\n== last session ==`);
      if (!latest) console.log("（没有会话记录）");
      else {
        console.log(`${latest.modified}  ${format(latest.turns)}`);
        for (const [preset, summary] of Object.entries(latest.byPreset)) {
          console.log(`${preset.padEnd(12)} ${format(summary)}`);
        }
      }
    }
    process.exit(0);
  }
  if (process.argv.includes("--ab-plan")) {
    const records = [];
    for (const file of findSessionFiles(root)) {
      try {
        records.push(...readRecords(readFileSync(file, "utf8")));
      } catch {
        // Skip an unreadable session rather than failing the plan.
      }
    }
    const gate = planGate(liveReport());
    for (const line of gate.lines) console.log(line);
    if (gate.blocked) process.exit(0);
    const plan = abPlan(turnsByPreset(records));
    if (json) console.log(JSON.stringify(plan, null, 2));
    else {
      console.log(`现在：off ${plan.turns.off} 轮 / standard ${plan.turns.standard} 轮（每侧至少 ${MIN_TURNS_FOR_COMPARISON} 轮）`);
      for (const step of plan.steps) console.log(step);
      console.log(plan.ready ? "\n两侧都够了，跑第 3 步就能出判定。" : "\n还差上面的轮次；跑够再执行第 3 步。");
    }
    process.exit(0);
  }
  if (process.argv.includes("--ab")) {
    const records = [];
    for (const file of findSessionFiles(root)) {
      try {
        records.push(...readRecords(readFileSync(file, "utf8")));
      } catch {
        // Skip an unreadable session rather than failing the whole report.
      }
    }
    const result = presetComparison(turnsByPreset(records));
    if (json) console.log(JSON.stringify(result, null, 2));
    else if (!result.verdict) console.log(`不足以判定：${result.reason}。`);
    else {
      const { verdict, baseline, treatment } = result;
      console.log(
        `${baseline} → ${treatment}: ${verdict.conclusion}`
          + ` | median turn ${verdict.medianTurnSeconds.before}s → ${verdict.medianTurnSeconds.after}s (${verdict.medianTurnSeconds.deltaPercent}%)`
          + ` | output/turn ${verdict.outputPerTurn.before} → ${verdict.outputPerTurn.after} (${verdict.outputPerTurn.deltaPercent}%)`
          + ` | cache share ${verdict.cacheReadShare.before} → ${verdict.cacheReadShare.after}`,
      );
      for (const note of verdict.notes) console.log(`注意：${note}`);
      if (verdict.conclusion === "insufficient") {
        console.log(`样本不足（每侧至少 ${verdict.minTurns} 轮）：${baseline} 还差 ${verdict.shortfall.before} 轮 / ${treatment} 还差 ${verdict.shortfall.after} 轮。`);
      }
    }
    process.exit(0);
  }
  if (process.argv.includes("--by-preset")) {
    const records = [];
    for (const file of findSessionFiles(root)) {
      try {
        records.push(...readRecords(readFileSync(file, "utf8")));
      } catch {
        // Skip an unreadable session rather than failing the whole report.
      }
    }
    const groups = [...turnsByPreset(records).entries()];
    if (json) console.log(JSON.stringify(Object.fromEntries(groups), null, 2));
    else {
      for (const [preset, summary] of groups) console.log(`${preset.padEnd(12)} ${format(summary)}`);
      if (!groups.some(([preset]) => preset !== "unrecorded")) {
        console.log("\n还没有任何会话记录过档位（pi-web:fast-mode 条目从 1.7.x 迁入后才写）。");
      }
    }
    process.exit(0);
  }
  if (process.argv.includes("--last")) {
    const latest = latestSession(root);
    if (json) console.log(JSON.stringify(latest, null, 2));
    else if (!latest) console.log(`没有会话记录：${root}`);
    else {
      console.log(`last session ${latest.modified}\n${latest.file}`);
      console.log(`\n${format(latest.turns)}`);
      for (const [preset, summary] of Object.entries(latest.byPreset)) {
        console.log(`${preset.padEnd(12)} ${format(summary)}`);
      }
      console.log(
        `tools ${latest.tools.calls} results | ${latest.tools.chars} chars | ${(latest.tools.shareOfMessageChars * 100).toFixed(1)}%`
          + ` | steps ${latest.steps.steps} | calls/step ${latest.steps.callsPerStep} | parallel ${(latest.steps.parallelStepShare * 100).toFixed(0)}%`,
      );
    }
    process.exit(0);
  }
  if (process.argv.includes("--steps")) {
    const records = [];
    for (const file of findSessionFiles(root)) {
      try {
        records.push(...readRecords(readFileSync(file, "utf8")));
      } catch {
        // Skip an unreadable session rather than failing the whole report.
      }
    }
    const steps = measureSteps(records);
    const summary = summarizeSteps(steps);
    const byPreset = segmentRecords(records)
      .filter((segment) => segment.preset !== "unrecorded")
      .map((segment) => ({ preset: segment.preset, ...summarizeSteps(measureSteps(segment.records)) }));
    for (const row of byPreset) {
      console.log(
        `[${row.preset}] steps ${row.steps} | calls ${row.calls} | calls/step ${row.callsPerStep}`
          + ` | parallel ${(row.parallelStepShare * 100).toFixed(0)}% | duplicates ${row.duplicateCalls}`,
      );
    }
    if (json) console.log(JSON.stringify({ ...summary, byPreset }, null, 2));
    else {
      for (const step of steps) {
        console.log(
          `${new Date(step.at).toISOString().slice(11, 19)}  ${step.calls.length} call(s): `
            + step.calls.map((call) => call.name).join(", "),
        );
      }
      console.log(
        `\nsteps ${summary.steps} | calls ${summary.calls} | calls/step ${summary.callsPerStep}`
          + ` | max parallel ${summary.maxParallel} | parallel steps ${(summary.parallelStepShare * 100).toFixed(0)}%`
          + ` | duplicate calls ${summary.duplicateCalls} (${(summary.duplicateShare * 100).toFixed(0)}%)`,
      );
      console.log("串行步骤多 = 每次往返都付一次 prefill + 网关延迟；pi 会把同一条消息里的兄弟调用并发跑。");
    }
    process.exit(0);
  }
  if (process.argv.includes("--tools")) {
    const records = [];
    let allChars = 0;
    for (const file of findSessionFiles(root)) {
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const parsed = readRecords(text);
      records.push(...parsed);
      allChars += messageChars(parsed);
    }
    const segments = segmentRecords(records);
    const byPreset = segments.map((segment) => ({
      preset: segment.preset,
      ...summarizeTools(measureToolResults(segment.records), messageChars(segment.records)),
    }));
    for (const row of byPreset) {
      if (row.preset === "unrecorded") continue;
      console.log(
        `[${row.preset}] tool results ${row.calls} | ${row.chars} chars | ${(row.shareOfMessageChars * 100).toFixed(1)}% of message chars`,
      );
    }
    const summary = summarizeTools(measureToolResults(records), allChars);
    if (json) console.log(JSON.stringify({ ...summary, byPreset }, null, 2));
    else {
      for (const row of summary.tools) {
        console.log(
          `${row.tool.padEnd(18)} calls ${String(row.calls).padStart(3)} | chars ${String(row.chars).padStart(6)}`
            + ` | median ${row.medianChars} p90 ${row.p90Chars} max ${row.maxChars}`
            + ` | ${Math.round(row.totalMs / 100) / 10}s | errors ${row.errors}`,
        );
      }
      console.log(
        `\ntool results ${summary.calls} | ${summary.chars} chars`
          + ` | ${(summary.shareOfMessageChars * 100).toFixed(1)}% of all message characters`,
      );
    }
    process.exit(0);
  }
  if (compareAt !== undefined) {
    const splitAt = Date.parse(compareAt);
    if (!Number.isFinite(splitAt)) {
      console.error(`--compare is not a timestamp: ${compareAt}`);
      process.exit(2);
    }
    const before = measureRoot(root, { since }).total;
    const after = measureRoot(root, { since: compareAt }).total;
    const beforeOnly = {
      ...before,
      output: before.output - after.output,
      input: before.input - after.input,
      cacheRead: before.cacheRead - after.cacheRead,
      totalTokens: before.totalTokens - after.totalTokens,
      turns: before.turns - after.turns,
    };
    const verdict = compare(beforeOnly, after);
    if (json) console.log(JSON.stringify({ before: beforeOnly, after, verdict }, null, 2));
    else {
      console.log(`before ${compareAt}: ${format(beforeOnly)}`);
      console.log(`after  ${compareAt}: ${format(after)}`);
      console.log(
        `\n${verdict.conclusion}: median turn ${verdict.medianTurnSeconds.before}s → ${verdict.medianTurnSeconds.after}s (${verdict.medianTurnSeconds.deltaPercent}%)`
          + ` | output/turn ${verdict.outputPerTurn.before} → ${verdict.outputPerTurn.after} (${verdict.outputPerTurn.deltaPercent}%)`
          + ` | cache share ${verdict.cacheReadShare.before} → ${verdict.cacheReadShare.after}`,
      );
      for (const note of verdict.notes) console.log(`注意：${note}`);
      if (verdict.conclusion === "insufficient") {
        console.log(`样本不足（每侧至少 ${verdict.minTurns} 轮），不做结论。`);
      }
    }
    process.exit(0);
  }
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`root ${root}${since ? ` since ${since}` : ""}`);
    for (const session of result.sessions) console.log(`${session.modified}  ${format(session)}`);
    console.log(`\nTOTAL  ${format(result.total)}`);
  }
}
