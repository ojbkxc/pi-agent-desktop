#!/usr/bin/env node
/**
 * Do the tests actually fail when the code is wrong?
 *
 * A green suite proves nothing about an assertion that never runs or one that
 * cannot distinguish right from wrong. This harness breaks the code on purpose,
 * runs the named tests, and requires them to go red — then restores the file.
 *
 * The mutations are the ones worth keeping: each guards a rule that a plausible
 * refactor would break silently (a section writer moved after a force-prompt
 * handler, a branch losing its registration, an outward-facing name renamed).
 *
 *   node scripts/mutation-smoke.mjs            # all
 *   node scripts/mutation-smoke.mjs --id order  # one
 *   node scripts/mutation-smoke.mjs --json
 *
 * Exit codes: 0 every mutation went red and the final green run passed,
 * 1 a mutation stayed green (the test does not guard its rule),
 * 2 the harness itself is broken (anchor missing, backup left behind).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const backupSuffix = ".mutation-backup";

/** Each entry breaks one rule and names the tests that must notice. */
export const MUTATIONS = [
  {
    id: "chat-branch",
    why: "the workspace-chat branch loses its factory, so chats silently stop getting the section",
    file: "lib/rpc-manager.ts",
    apply: (source) =>
      source.replace(
        /\r?\n {14,16}\/\/ 快速模式：只加 `sections\.fast_mode`[^\n]*\r?\n {14,16}\/\/ chat-only[^\n]*\r?\n {14,16}createFastModeExtension\(\),/,
        "",
      ),
    tests: ["lib/fast-mode/extension.test.mjs"],
  },
  {
    id: "order",
    why: "the section writer moves after the force-prompt handler, so its section never reaches the prompt",
    file: "lib/rpc-manager.ts",
    apply: (source) => {
      const lineRe = /^ {14}createFastModeExtension\(\),\r?\n/m;
      const purgeRe = /^ {14}createPurgeExtension\(\{ readModel: [^\n]*\}\),\r?\n/gm;
      const hit = lineRe.exec(source);
      if (!hit) return source;
      const without = source.slice(0, hit.index) + source.slice(hit.index + hit[0].length);
      const purges = [...without.matchAll(purgeRe)];
      if (!purges.length) return source;
      const target = purges[purges.length - 1];
      const end = target.index + target[0].length;
      const eol = source.includes("\r\n") ? "\r\n" : "\n";
      return `${without.slice(0, end)}              createFastModeExtension(),${eol}${without.slice(end)}`;
    },
    tests: ["lib/fast-mode/extension.test.mjs"],
  },
  {
    id: "section-name",
    why: "the outward-facing section key is renamed, which every import would follow silently",
    file: "lib/fast-mode/guidance.ts",
    apply: (source) => source.replace(
      'export const FAST_MODE_SECTION = "fast_mode";',
      'export const FAST_MODE_SECTION = "fast-mode";',
    ),
    tests: ["lib/fast-mode/extension.test.mjs"],
  },
  {
    id: "save-stale-ok",
    why: "a superseded save response is accepted, so an older answer overwrites a newer pick",
    file: "components/server-setting-machine.ts",
    apply: (source) => source.replace(
      /    case "ok":\r?\n      if \(action\.token !== state\.token\) return state;/,
      '    case "ok":',
    ),
    tests: ["components/server-setting-machine.test.mjs"],
  },
  {
    id: "save-no-rollback",
    why: "a failed save keeps the optimistic value instead of restoring the confirmed one",
    file: "components/server-setting-machine.ts",
    apply: (source) => source.replace(
      'return { ...state, value: state.previous, saving: false, failed: true };',
      'return { ...state, value: state.value, saving: false, failed: true };',
    ),
    tests: ["components/server-setting-machine.test.mjs"],
  },
  {
    id: "row-freezes-on-read-failure",
    why: "an unknown value stops showing the fallback, so a failed read leaves the row blank",
    file: "components/server-setting-machine.ts",
    apply: (source) => source.replace(
      "  return value === null ? fallback : value;",
      "  return value as T;",
    ),
    tests: ["components/server-setting-machine.test.mjs"],
  },
];

function runTests(files) {
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--test", ...files],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  return {
    status: run.status,
    pass: Number(/^# pass (\d+)$/m.exec(output)?.[1] ?? 0),
    fail: Number(/^# fail (\d+)$/m.exec(output)?.[1] ?? 0),
    failed: [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1]),
  };
}

/** Apply one mutation, run its tests, and always restore. Returns the observation. */
export function observeMutation(entry) {
  const backup = `${entry.file}${backupSuffix}`;
  if (existsSync(backup)) {
    return { id: entry.id, ok: false, error: `leftover backup ${backup}: restore it by hand first` };
  }
  const original = readFileSync(entry.file, "utf8");
  const mutated = entry.apply(original);
  if (mutated === original) {
    return { id: entry.id, ok: false, error: "anchor missing: the mutation changed nothing" };
  }
  writeFileSync(backup, original);
  writeFileSync(entry.file, mutated);
  try {
    const result = runTests(entry.tests);
    return {
      id: entry.id,
      why: entry.why,
      ok: result.status !== 0,
      pass: result.pass,
      fail: result.fail,
      failed: result.failed.slice(0, 3),
    };
  } finally {
    writeFileSync(entry.file, original);
    rmSync(backup, { force: true });
  }
}

function main() {
  const json = process.argv.includes("--json");
  const idAt = process.argv.indexOf("--id");
  const only = idAt >= 0 ? process.argv[idAt + 1] : undefined;
  const entries = only ? MUTATIONS.filter((entry) => entry.id === only) : MUTATIONS;
  if (entries.length === 0) {
    console.error(`unknown --id: ${only}. Known: ${MUTATIONS.map((entry) => entry.id).join(", ")}`);
    process.exit(2);
  }
  const results = entries.map(observeMutation);
  const broken = results.filter((result) => result.error);
  const survived = results.filter((result) => !result.error && !result.ok);
  // The restore check runs the union of every mutation's tests, so a mutation that
  // broke something outside its own list still fails the run instead of passing.
  const touched = [...new Set(MUTATIONS.flatMap((entry) => entry.tests))];
  const green = runTests(touched);

  if (json) {
    console.log(JSON.stringify({ results, restoredGreen: green.status === 0 }, null, 2));
  } else {
    for (const result of results) {
      if (result.error) console.log(`${result.id}: HARNESS ${result.error}`);
      else if (result.ok) console.log(`${result.id}: RED as expected (${result.failed.join("; ")})`);
      else console.log(`${result.id}: GREEN — this test does not guard: ${result.why}`);
    }
    console.log(`\nrestored: ${green.status === 0 ? "green" : "NOT green — check the working tree"}`);
    console.log(survived.length === 0 ? "OK" : "FAILED");
  }
  if (broken.length) process.exit(2);
  process.exit(survived.length === 0 && green.status === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main();
}