#!/usr/bin/env node
/**
 * The numbers this feature's decisions rest on, re-measurable.
 *
 * D10 removed a 258 µs file read from the per-turn path; D11 said caching the
 * 1.18 µs section build is not worth it. Both are claims about cost, so both can
 * silently rot — a refactor that adds a `stat` to the section builder, or a cache
 * that never hits, would leave the docs true and the code wrong. This script
 * measures the same paths and fails when one crosses its limit.
 *
 * Needs the TypeScript loader, like every other lib test:
 *   node --experimental-strip-types scripts/microbench.mjs [--json]
 *
 * Exit codes: 0 every benchmark within its limit, 1 one crossed it.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildFastModeSection, resolveFastModeConfig } = await jiti.import("../lib/fast-mode/guidance.ts");
const { readFastModeConfig } = await jiti.import("../lib/fast-mode/settings.ts");
const { initialSaveState, reduceSave } = await jiti.import("../components/server-setting-machine.ts");

/** Limits are 5–10× the measured value, so only a real regression trips them. */
export const BENCHES = [
  { id: "section-build", label: "buildFastModeSection(standard)", limitUs: 12, iterations: 5000 },
  { id: "config-cached", label: "readFastModeConfig (cache hit)", limitUs: 500, iterations: 2000 },
  { id: "config-uncached", label: "readFastModeConfig (cache miss)", limitUs: null, iterations: 300 },
  { id: "reduce-save", label: "reduceSave transition", limitUs: 5, iterations: 20000 },
];

/** `{ id, perCallUs, limitUs }` → which ones crossed the line. */
export function evaluate(results) {
  return results.filter((result) => result.limitUs !== null && result.perCallUs > result.limitUs);
}

function time(label, iterations, run) {
  run(); // warm up: the first call pays for lazy module work
  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) run();
  const nanos = Number(process.hrtime.bigint() - started);
  return Number((nanos / iterations / 1000).toFixed(2));
}

function benchSection() {
  const config = resolveFastModeConfig("standard");
  return time("section", 5000, () => buildFastModeSection(config));
}

function benchConfigCached(settingsPath) {
  writeFileSync(settingsPath, JSON.stringify({ fastMode: { preset: "standard" }, pad: "x".repeat(4000) }));
  readFastModeConfig(settingsPath);
  return time("cached", 2000, () => readFastModeConfig(settingsPath));
}

function benchConfigUncached(settingsPath) {
  let tick = 0;
  return time("uncached", 300, () => {
    tick += 1;
    const when = new Date(Date.now() + tick * 1000);
    utimesSync(settingsPath, when, when);
    readFastModeConfig(settingsPath);
  });
}

function benchReduce() {
  const state = reduceSave(initialSaveState(), { type: "load", value: "off" });
  let token = 0;
  return time("reduce", 20000, () => {
    token += 1;
    const started = reduceSave(state, { type: "start", next: "standard", token });
    return reduceSave(started, { type: "ok", token, value: "standard" });
  });
}

function main() {
  const json = process.argv.includes("--json");
  const dir = mkdtempSync(join(tmpdir(), "pi-web-microbench-"));
  const settingsPath = join(dir, "settings.json");
  let results;
  try {
    results = [
      { ...BENCHES[0], perCallUs: benchSection() },
      { ...BENCHES[1], perCallUs: benchConfigCached(settingsPath) },
      { ...BENCHES[2], perCallUs: benchConfigUncached(settingsPath) },
      { ...BENCHES[3], perCallUs: benchReduce() },
    ];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const over = evaluate(results);
  if (json) {
    console.log(JSON.stringify({ results, over: over.map((result) => result.id) }, null, 2));
  } else {
    for (const result of results) {
      const limit = result.limitUs === null ? "   (informational)" : `limit ${result.limitUs} µs`;
      console.log(`${result.label.padEnd(34)} ${String(result.perCallUs).padStart(8)} µs/call  ${limit}`);
    }
    console.log(over.length ? `\nOVER LIMIT: ${over.map((result) => result.id).join(", ")}` : "\nOK");
  }
  process.exit(over.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main();
}