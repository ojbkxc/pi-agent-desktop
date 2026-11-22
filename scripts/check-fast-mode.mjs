#!/usr/bin/env node
/**
 * One command for "is fast mode still working".
 *
 * Runs the exact list in `fast-mode-checks.mjs` through `node --test`, then
 * prints a one-screen verdict. Exit codes: 0 all green, 1 a test failed,
 * 2 the list itself is broken (a file is missing), so a broken check cannot
 * look like a passing one.
 *
 *   node scripts/check-fast-mode.mjs
 *   node scripts/check-fast-mode.mjs --json
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { FAST_MODE_CHECK_FILES, parseFailures, parseTestSummary } from "./fast-mode-checks.mjs";
import { liveReport } from "./fast-mode-live.mjs";

const json = process.argv.includes("--json");
if (process.argv.includes("--live")) {
  const report = liveReport();
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`agent dir: ${report.agentDir}`);
    console.log(`setting:   fastMode.preset = ${report.preset}`);
    console.log(`evidence:  ${report.entries} pi-web:fast-mode 条目（最近会话 ${report.lastSessionAt ?? "无"}）`);
    console.log(`prompt:    ${report.promptSeen ? "最近会话的 system 消息里有 fast_mode 段落" : "最近会话里没看到该段落"}`);
    for (const layer of report.layers) {
      console.log(`  [${layer.ok ? "ok  " : "MISS"}] ${layer.name.padEnd(10)} ${layer.detail}`);
    }
    console.log(`\n${report.status}`);
    console.log(report.verdict);
    for (const step of report.steps) console.log(step);
  }
  process.exit(0);
}
const missing = FAST_MODE_CHECK_FILES.filter((file) => !existsSync(file));
if (missing.length) {
  if (json) console.log(JSON.stringify({ ok: false, missing }, null, 2));
  else console.error(`清单里有不存在的文件，先修清单：\n  ${missing.join("\n  ")}`);
  process.exit(2);
}

const run = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--test", ...FAST_MODE_CHECK_FILES],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
const summary = parseTestSummary(output);
const failures = parseFailures(output);
const ok = run.status === 0 && summary !== null && summary.fail === 0;

if (json) {
  console.log(JSON.stringify({ ok, summary, failures, exit: run.status }, null, 2));
} else if (!summary) {
  console.error("没有拿到测试汇总输出，先单独跑一个文件看原因：");
  console.error(output.split(/\r?\n/).slice(-20).join("\n"));
} else {
  console.log(`fast-mode checks: ${summary.tests} tests | ${summary.pass} pass | ${summary.fail} fail`);
  console.log(`files: ${FAST_MODE_CHECK_FILES.length}`);
  if (failures.length) {
    console.log("\nfailing:");
    for (const name of failures) console.log(`  - ${name}`);
  }
  console.log(ok ? "\nOK" : "\nFAILED");
}
process.exit(ok ? 0 : 1);
