import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the file viewer toolbar names the platform's file manager and reports failures", async () => {
  const viewer = await read("./FileViewer.tsx");
  assert.doesNotMatch(viewer, /"Reveal in Finder"|"Open with default app"|"Live sync (active|unavailable)"/);
  assert.match(viewer, /t\(revealLabelKey\(getDesktopPlatform\(\)\)\)/);
  assert.match(viewer, /appNotify\.error\(/);
});

test("the project picker's own copy goes through translations", async () => {
  const picker = await read("./ProjectPicker.tsx");
  for (const literal of ["Select project…", "Filter projects…", "No matching projects", "Use default directory", "Open Folder…"]) {
    assert.ok(!picker.includes(literal), `ProjectPicker still hard-codes "${literal}"`);
  }
});

test("PluginsConfig ignores a loadPlugins response that a newer load superseded", async () => {
  const source = await read("./PluginsConfig.tsx");
  const start = source.indexOf("const loadPlugins = useCallback(async () => {");
  assert.ok(start > 0, "loadPlugins not found");
  const body = source.slice(start, source.indexOf("}, [cwd]);", start));
  assert.match(body, /const requestId = \+\+loadRequestRef\.current;/);
  // The guard runs before any state write from the response.
  const guard = body.indexOf("if (!isCurrent()) return");
  assert.ok(guard > 0 && guard < body.indexOf("if (!res.ok"), "stale guard must precede the response handling");
  assert.match(body, /if \(isCurrent\(\)\) setLoading\(false\)/);
});

test("SkillsConfig keeps its superseded-load guard and drops the Error: prefix", async () => {
  const source = await read("./SkillsConfig.tsx");
  const start = source.indexOf("const loadSkills = useCallback(async () => {");
  assert.ok(start > 0, "loadSkills not found");
  const body = source.slice(start, source.indexOf("}, [cwd]);", start));
  // The fork guard is generation-based (loadSkillsSeqRef) rather than loadRequestRef.
  assert.match(body, /const generation = \+\+loadSkillsSeqRef\.current;/);
  assert.match(body, /if \(generation !== loadSkillsSeqRef\.current\) return \[\]/);
  assert.match(body, /if \(generation === loadSkillsSeqRef\.current\) setLoading\(false\)/);
  assert.match(body, /e instanceof Error \? e\.message : String\(e\)/);
});

test("ServerSwitchSettingRow ignores a superseded save response", async () => {
  const source = await read("./ServerSwitchSettingRow.tsx");
  // The row defers to the shared round trip, so this guard lives in one place for
  // every server-backed row (the three-way fast-mode row included).
  assert.match(source, /useServerSetting<boolean>/, "the row must use the shared hook");
  assert.doesNotMatch(source, /saveSeq/, "the row must not keep a private save counter");

  const hook = await read("../hooks/useServerSetting.ts");
  // Rapid toggles: the first PUT may answer last. The hook mints a token per save
  // and the reducer drops any answer carrying an older one.
  assert.match(hook, /tokenRef\.current \+= 1;/);
  assert.match(hook, /dispatch\(\{ type: "ok", token, /);
  assert.match(hook, /dispatch\(\{ type: "fail", token \}\)/);
  const machine = await read("./server-setting-machine.ts");
  assert.match(machine, /if \(action\.token !== state\.token\) return state;/, "stale responses are dropped");
  assert.match(machine, /value: state\.previous/, "a real failure rolls back");
});

test("OutageSettings' cancel-all treats a non-OK response as a failure", async () => {
  const source = await read("./OutageSettings.tsx");
  const start = source.indexOf('body: JSON.stringify({ action: "cancel-all" }),');
  assert.ok(start > 0, "cancel-all request not found");
  const body = source.slice(start, source.indexOf(".finally(", start));
  assert.match(body, /if \(!response\.ok\) throw new Error\(`HTTP \$\{response\.status\}`\)/);
});

test("PinnedSessionsSettings keeps busy state per row instead of freezing every row", async () => {
  const source = await read("./PinnedSessionsSettings.tsx");
  assert.doesNotMatch(source, /const \[busy, setBusy\]/, "共享 busy 会让一行的解除动作把所有行变成保存中");
  assert.match(source, /const \[pinning, setPinning\]/);
  assert.match(source, /const \[unpinning, setUnpinning\]/);
  assert.match(source, /busy=\{unpinning\.has\(entry\.sessionId\)\}/);

  const start = source.indexOf("const unpin = async (sessionId: string) => {");
  assert.ok(start > 0, "unpin not found");
  const body = source.slice(start, source.indexOf("\n  };", start));
  assert.match(body, /setUnpinning\(\(previous\) => new Set\(previous\)\.add\(sessionId\)\)/);
  assert.match(body, /next\.delete\(sessionId\)/, "完成后只清自己那一行");
});