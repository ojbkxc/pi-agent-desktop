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
  const start = source.indexOf("const update = (next: boolean) => {");
  assert.ok(start > 0, "update not found");
  const body = source.slice(start, source.indexOf("};", source.indexOf(".finally(() =>")));
  // Rapid toggles: the first PUT may answer last. Without a sequence guard its
  // value (or its rollback) would overwrite the newer toggle.
  assert.match(body, /const seq = \+\+saveSeq\.current;/);
  assert.match(body, /const isCurrent = \(\) => seq === saveSeq\.current;/);
  assert.match(body, /\.then\(\(data: \{ enabled\?: unknown \}\) => \{\r?\n\s+if \(!isCurrent\(\)\) return;/);
  const catchStart = body.indexOf(".catch(() => {");
  const finallyStart = body.indexOf(".finally(");
  assert.ok(catchStart > 0 && finallyStart > catchStart, "catch/finally blocks found");
  assert.match(body.slice(catchStart, finallyStart), /if \(!isCurrent\(\)\) return;/);
  assert.match(body, /if \(isCurrent\(\)\) setSaving\(false\)/);
});

test("OutageSettings' cancel-all treats a non-OK response as a failure", async () => {
  const source = await read("./OutageSettings.tsx");
  const start = source.indexOf('body: JSON.stringify({ action: "cancel-all" }),');
  assert.ok(start > 0, "cancel-all request not found");
  const body = source.slice(start, source.indexOf(".finally(", start));
  assert.match(body, /if \(!response\.ok\) throw new Error\(`HTTP \$\{response\.status\}`\)/);
});