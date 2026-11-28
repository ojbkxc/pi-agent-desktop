import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// `/name` must promote a freshly-created composer session (draft re-key + AppShell
// notice). `loadSession` returns null unless `includeState` is true, so the old
// `if (await loadSession(sid)) promoteNewSession()` never fired. This runs the real
// handler source against a behaviour-faithful mock of loadSession.

const read = async (path) => (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const hookSource = await read("./useAgentSession.ts");
const hookFile = ts.createSourceFile("useAgentSession.ts", hookSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** The function a `const <name> = useCallback(fn, deps)` declaration wraps, as JavaScript. */
function callbackSource(name) {
  let found;
  const visit = (node) => {
    if (found) return;
    if (
      ts.isVariableDeclaration(node)
      && node.name.getText(hookFile) === name
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(hookFile) === "useCallback"
    ) {
      found = node.initializer.arguments[0];
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(hookFile);
  assert.ok(found, `useCallback ${name} not found`);
  return ts.transpileModule(`(${found.getText(hookFile)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.trim().replace(/;$/, "");
}

// The handler reads hook state as free variables; `with` resolves them from the scope.
const runHandler = new Function(
  "scope",
  `with (scope) { return ${callbackSource("handleBuiltinSlashCommand")}; }`,
);

function hook() {
  const calls = { notices: [], requests: [], loadArgs: [], promoted: 0 };
  const scope = {
    sessionIdRef: { current: "session-1" },
    ensureNewSession: async () => "session-1",
    addNotice: (notice) => calls.notices.push(notice),
    sendAgentCommand: (sid, command) => {
      calls.requests.push({ sid, command });
      return Promise.resolve({});
    },
    // Faithful to the real loadSession: includeState=false returns null.
    loadSession: async (sid, showLoading, includeState) => {
      calls.loadArgs.push({ sid, showLoading, includeState });
      return includeState ? { running: false } : null;
    },
    promoteNewSession: () => { calls.promoted += 1; },
    // i18n: the handler calls t(key, params); return the key so assertions can
    // verify which translation key the handler selected.
    t: (key) => key,
  };
  return { run: runHandler(scope), calls };
}

test("/name promotes a freshly created session (loads state so promote runs)", async () => {
  const { run, calls } = hook();
  const result = await run("/name My Rename");

  assert.deepEqual(result, { handled: true, message: "chat.sessionRenamedTo" });
  assert.deepEqual(
    calls.requests.map((entry) => entry.command),
    [{ type: "set_session_name", name: "My Rename" }],
  );
  // The regression: includeState must be true — otherwise loadSession returns null
  // and promoteNewSession (draft re-key + AppShell notice) never runs.
  assert.equal(calls.loadArgs.at(-1).includeState, true, "loadSession must includeState to get a truthy result");
  assert.equal(calls.promoted, 1, "promoteNewSession must run so a new session becomes a real one");
});

test("/name without an argument does not touch the session", async () => {
  const { run, calls } = hook();
  assert.deepEqual(await run("/name"), { handled: true, error: "chat.nameUsage" });
  assert.equal(calls.requests.length, 0);
  assert.equal(calls.promoted, 0);
});
