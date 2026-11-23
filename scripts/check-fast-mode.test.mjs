import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import test from "node:test";
import { FAST_MODE_CHECK_FILES, parseFailures, parseTestSummary } from "./fast-mode-checks.mjs";
import { liveReport } from "./fast-mode-live.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { readFastModeConfig } = await jiti.import("../lib/fast-mode/settings.ts");
const runtimeReader = () => readFastModeConfig();

test("every listed file exists and is a test", () => {
  for (const file of FAST_MODE_CHECK_FILES) {
    assert.ok(existsSync(file), `missing: ${file}`);
    assert.match(file, /\.test\.mjs$/, `not a test file: ${file}`);
  }
  assert.equal(new Set(FAST_MODE_CHECK_FILES).size, FAST_MODE_CHECK_FILES.length, "no duplicates");
});

test("the list covers the feature's four layers, not just its unit tests", () => {
  for (const pattern of [
    /^lib\/fast-mode\//,
    /^app\/api\/fast-mode\//,
    /^components\//,
    /^scripts\/measure-turns\.test\.mjs$/,
  ]) {
    assert.ok(FAST_MODE_CHECK_FILES.some((file) => pattern.test(file)), `nothing matches ${pattern}`);
  }
});

test("the summary parser reads the TAP counts it is given", () => {
  const output = ["# tests 12", "# pass 11", "# fail 1", "# cancelled 0", "1..12"].join("\n");
  assert.deepEqual(parseTestSummary(output), { tests: 12, pass: 11, fail: 1, cancelled: 0 });
  assert.equal(parseTestSummary("no summary here"), null);
});

test("the summary parser also reads the spec reporter node prints by default", () => {
  // node ≥22 在非 TTY 下写 `ℹ tests 144`（ℹ = U+2139，有时跟 U+FE0F）。只认 TAP 的
  // 解析器在这里返回 null，于是测试全绿也被判成失败——这条断言钉住那次回归。
  const output = [
    "ℹ tests 144",
    "ℹ suites 0",
    "ℹ pass 144",
    "ℹ fail 0",
    "ℹ cancelled 0",
    "ℹ duration_ms 10948.9",
  ].join("\r\n");
  assert.deepEqual(parseTestSummary(output), { tests: 144, pass: 144, fail: 0, cancelled: 0 });
  assert.deepEqual(
    parseTestSummary("ℹ\uFE0F tests 3\nℹ\uFE0F pass 2\nℹ\uFE0F fail 1"),
    { tests: 3, pass: 2, fail: 1, cancelled: 0 },
    "the variation selector must not defeat the match",
  );
});

test("failures are named, so the report says what broke", () => {
  const output = ["ok 1 - fine", "not ok 2 - the guard is missing", "not ok 7 - rolls back"].join("\n");
  assert.deepEqual(parseFailures(output), ["the guard is missing", "rolls back"]);
});

test("spec failures are named too, once each", () => {
  // spec 会在运行行报一次、在 "failing tests:" 段再报一次同名条目。
  const output = [
    "✖ sibling calls run concurrently (593.4ms)",
    "✔ something fine (1.2ms)",
    "✖ failing tests:",
    "✖ sibling calls run concurrently (593.4ms)",
  ].join("\n");
  assert.deepEqual(parseFailures(output), ["sibling calls run concurrently"]);
});

test("the runner refuses a broken list instead of reporting success", () => {
  const source = readFileSync(new URL("./check-fast-mode.mjs", import.meta.url), "utf8");
  assert.match(source, /process\.exit\(2\)/, "a missing file is exit 2, distinct from a test failure");
  assert.match(source, /missing\.length/, "the run must stop before spawning");
  assert.match(source, /--experimental-strip-types/, "the runner must use the same node flags the suite needs");
});

test("--live separates what would run from what did run", () => {
  const source = readFileSync(new URL("./fast-mode-live.mjs", import.meta.url), "utf8");
  assert.match(source, /fastMode\?\.preset/, "it reads the stored preset");
  assert.match(source, /pi-web:fast-mode"\)\.length - 1/, "it counts session entries as evidence");
  assert.match(source, /尚无使用证据/, "an unused feature is reported as such, not as working");
  assert.match(
    readFileSync(new URL("./check-fast-mode.mjs", import.meta.url), "utf8"),
    /if \(process\.argv\.includes\("--live"\)\)[\s\S]*?process\.exit\(0\)/,
    "--live is informational and never fails a run",
  );
});

test("--live tells the operator what to do when nothing has run yet", () => {
  const source = readFileSync(new URL("./fast-mode-live.mjs", import.meta.url), "utf8");
  assert.match(source, /重启正在用的 pi-web 进程/, "the checklist starts with the restart");
  assert.match(source, /发一轮对话/, "then one turn");
  assert.match(source, /条目数应从 0 变成/, "then the acceptance check, with its expected output");
  assert.match(source, /steps: entries > 0\s*\n?\s*\? \[\]/, "a feature already in use gets no checklist");
});

test("the operator report and the runtime reader agree on the same file", () => {
  // The CLI parses settings.json on its own so `--live` can run without the TypeScript
  // loader; that duplication is fine only while both read the file the same way.
  const dir = mkdtempSync(join(tmpdir(), "pi-web-live-agree-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    mkdirSync(join(dir, "pi-web"), { recursive: true });
    for (const [body, expected] of [
      [JSON.stringify({ fastMode: { preset: "standard" } }), "standard"],
      [JSON.stringify({ fastMode: { preset: "off" } }), "off"],
      [JSON.stringify({ fastMode: { preset: "turbo" } }), "off"],
      [JSON.stringify({}), "off"],
    ]) {
      const settings = join(dir, "pi-web", "settings.json");
      writeFileSync(settings, body);
      assert.equal(liveReport().preset, expected, `report says ${body}`);
      assert.equal(runtimeReader().preset, expected, `runtime says ${body}`);
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the live report separates ran from reached-the-prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-live-prompt-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    mkdirSync(join(dir, "pi-web"), { recursive: true });
    mkdirSync(join(dir, "sessions", "proj"), { recursive: true });
    const session = join(dir, "sessions", "proj", "s.jsonl");
    writeFileSync(session, [
      JSON.stringify({ type: "custom", customType: "pi-web:fast-mode", data: { preset: "standard" } }),
      JSON.stringify({ type: "message", message: { role: "system", content: [{ type: "text", text: "<fast_mode>Speed rules for this session…" }] } }),
    ].join("\n"));
    const withSection = liveReport();
    assert.equal(withSection.entries, 1);
    assert.equal(withSection.promptSeen, true);
    assert.match(withSection.verdict, /能看到 fast_mode 段落/);

    writeFileSync(session, JSON.stringify({ type: "custom", customType: "pi-web:fast-mode", data: { preset: "off" } }));
    const withoutSection = liveReport();
    assert.equal(withoutSection.entries, 1);
    assert.equal(withoutSection.promptSeen, false);
    assert.match(withoutSection.verdict, /没看到段落/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the report names the first broken layer, in fixing order", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-live-layers-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    mkdirSync(join(dir, "pi-web"), { recursive: true });
    writeFileSync(join(dir, "pi-web", "settings.json"), JSON.stringify({ fastMode: { preset: "off" } }));
    const off = liveReport();
    assert.deepEqual(off.layers.map((layer) => layer.name), ["configure", "run", "prompt"]);
    assert.match(off.status, /先修第 1 层（configure）/);

    writeFileSync(join(dir, "pi-web", "settings.json"), JSON.stringify({ fastMode: { preset: "standard" } }));
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "sessions", "s.jsonl"), JSON.stringify({ type: "custom", customType: "pi-web:fast-mode", data: { preset: "standard" } }));
    const ran = liveReport();
    assert.match(ran.status, /先修第 3 层（prompt）/, "running without the section points at the prompt layer");

    writeFileSync(join(dir, "sessions", "s.jsonl"), [
      JSON.stringify({ type: "custom", customType: "pi-web:fast-mode", data: { preset: "standard" } }),
      JSON.stringify({ type: "message", message: { role: "system", content: "<fast_mode>Speed rules for this session" } }),
    ].join("\n"));
    const all = liveReport();
    assert.match(all.status, /全绿/);
    assert.ok(all.layers.every((layer) => layer.ok));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
