import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");
const start = source.indexOf('if (type === "watch")');
const end = source.indexOf("// type === \"list\"", start);
assert.notEqual(start, -1, "watch route not found");
assert.notEqual(end, -1, "watch route end not found");
const watchBlock = source.slice(start, end);

test("file watching survives same-path replacement", () => {
  assert.match(watchBlock, /watcher = fs\.watch\(watchedDirectory/);
  assert.match(watchBlock, /samePath\(path\.join\(watchedDirectory, changedName\.toString\(\)\), filePath\)/);
  assert.match(watchBlock, /s\.ctimeMs === lastCtimeMs/);
  assert.match(watchBlock, /s\.ino === lastIno/);
  assert.match(watchBlock, /lastExists/);
});

test("a missing target can be watched after its parent is authorized", () => {
  assert.match(source, /if \(type !== "watch"\)[\s\S]*error: "Not found"/);
  assert.match(source, /const existingAuthorizationPath = stat \? filePath : path\.dirname\(filePath\)/);
  assert.match(watchBlock, /lastExists = stat !== undefined/);
});

test("connected is emitted only after the watcher exists", () => {
  const watcher = watchBlock.indexOf("watcher = fs.watch");
  const connected = watchBlock.indexOf('send("connected"');
  assert.ok(watcher >= 0, "watcher creation missing");
  assert.ok(connected > watcher, "connected emitted before watcher creation");
});

test("every server-side close path stops the heartbeat and the watcher", () => {
  // A heartbeat left running after the server itself closes the stream
  // (watcher error, fs.watch failure) would tick forever; unref only keeps it
  // from blocking process exit. Both handlers end every path via cleanup(),
  // which only stops timers and closes the watcher — never enqueues.
  assert.equal((watchBlock.match(/cleanup\(\);\s*try \{ controller\.close\(\);/g) ?? []).length, 4);
  assert.equal((watchBlock.match(/cancel\(\) \{\s*cleanup\(\);/g) ?? []).length, 2);
  assert.doesNotMatch(watchBlock, /controller\.close\(\);\s*\n\s*cleanup\(\);/);
  assert.match(watchBlock, /const cleanup = \(\) => \{\s*if \(heartbeat\) clearInterval\(heartbeat\);/);
});
