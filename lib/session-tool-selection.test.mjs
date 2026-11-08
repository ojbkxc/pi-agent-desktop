import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  TOOL_SELECTION_TYPE,
  appendClearedSessionToolSelection,
  appendSessionToolSelection,
  readSessionToolSelection,
  validateSessionToolSelection,
} = await createJiti(import.meta.url).import("./session-tool-selection.ts");

function entry(data, customType = TOOL_SELECTION_TYPE) {
  return {
    type: "custom",
    customType,
    data,
    id: Math.random().toString(16),
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

test("a missing tool-selection entry identifies a legacy session", () => {
  assert.equal(readSessionToolSelection([]), undefined);
  assert.equal(readSessionToolSelection([entry({ version: 1, tools: [] }, "other")]), undefined);
});

test("an empty selection is distinct from a missing selection", () => {
  assert.deepEqual(readSessionToolSelection([entry({ version: 1, tools: [] })]), []);
});

test("the newest valid tool selection wins and invalid newer entries are ignored", () => {
  const entries = [
    entry({ version: 1, tools: ["read"] }),
    entry({ version: 2, tools: [] }),
    entry({ version: 1, tools: ["unknown"] }),
    entry({ version: 1, tools: ["bash", "read", "bash"] }),
  ];
  assert.deepEqual(readSessionToolSelection(entries), ["bash", "read"]);

  entries.push(entry({ version: 1, tools: "read" }));
  assert.deepEqual(readSessionToolSelection(entries), ["bash", "read"]);
});

test("tool selections accept only built-in tools", () => {
  assert.deepEqual(validateSessionToolSelection(["read", "write", "read"]), ["read", "write"]);
  assert.throws(() => validateSessionToolSelection(["read", "extension-tool"]), /built-in tool names/);
  assert.throws(() => validateSessionToolSelection(undefined), /built-in tool names/);
});

test("modifier-only selections are accepted for the full preset (需求3)", () => {
  const modifiers = ["+bash", "+read", "+edit", "+write", "+grep", "+find", "+ls"];
  assert.deepEqual(validateSessionToolSelection(modifiers), [...modifiers]);
  assert.deepEqual(
    readSessionToolSelection([entry({ version: 1, tools: [...modifiers] })]),
    [...modifiers],
  );
  // Deduped like bare names.
  assert.deepEqual(validateSessionToolSelection(["+bash", "+bash"]), ["+bash"]);
});

test("mixed bare and modifier selections are rejected like the SDK rejects them", () => {
  assert.throws(() => validateSessionToolSelection(["bash", "+read"]), /built-in tool names/);
  assert.equal(readSessionToolSelection([entry({ version: 1, tools: ["bash", "+read"] })]), undefined);
  // A "+name" that is not a built-in is still a non-built-in.
  assert.throws(() => validateSessionToolSelection(["+extension-tool"]), /built-in tool names/);
});

test("legacy bare-name pins from before the modifier form keep working", () => {
  // 硬要求: relaxing validation must not orphan pins written by older builds.
  assert.deepEqual(readSessionToolSelection([entry({ version: 1, tools: ["bash", "read"] })]), ["bash", "read"]);
  assert.deepEqual(validateSessionToolSelection(["bash"]), ["bash"]);
});

test("appending a selection writes the versioned custom entry", () => {
  const calls = [];
  appendSessionToolSelection({
    appendCustomEntry: (...args) => calls.push(args),
  }, []);
  assert.deepEqual(calls, [[TOOL_SELECTION_TYPE, { version: 1, tools: [] }]]);
});

test("a cleared entry retracts an earlier pin so the session follows configured defaults", () => {
  const pinned = [entry({ version: 1, tools: ["read", "bash"] })];
  assert.deepEqual(readSessionToolSelection(pinned), ["read", "bash"]);

  assert.equal(readSessionToolSelection([...pinned, entry({ version: 1, cleared: true })]), undefined);

  // A pin made after the clear wins again: newest valid entry still decides.
  assert.deepEqual(
    readSessionToolSelection([
      ...pinned,
      entry({ version: 1, cleared: true }),
      entry({ version: 1, tools: ["read"] }),
    ]),
    ["read"],
  );

  // Only an explicit `cleared: true` counts, and only at version 1.
  assert.deepEqual(
    readSessionToolSelection([...pinned, entry({ version: 1, cleared: false })]),
    ["read", "bash"],
  );
  assert.deepEqual(
    readSessionToolSelection([...pinned, entry({ version: 2, cleared: true })]),
    ["read", "bash"],
  );
});

test("a cleared entry is not a usable tool selection", () => {
  assert.throws(() => validateSessionToolSelection({ cleared: true }), /built-in tool names/);
});

test("appending a clear writes the versioned custom entry", () => {
  const calls = [];
  appendClearedSessionToolSelection({
    appendCustomEntry: (...args) => calls.push(args),
  });
  assert.deepEqual(calls, [[TOOL_SELECTION_TYPE, { version: 1, cleared: true }]]);
});
