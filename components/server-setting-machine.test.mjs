import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { initialSaveState, readOr, reduceSave, field, shown } from "./server-setting-machine.ts";

const start = (state, next) => reduceSave(state, { type: "start", next, token: state.token + 1 });

test("a load fills the value without touching the save flags", () => {
  const state = reduceSave(initialSaveState(), { type: "load", value: "standard" });
  assert.equal(state.value, "standard");
  assert.equal(state.saving, false);
  assert.equal(state.failed, false);
});

test("a start moves the value optimistically and remembers what to restore", () => {
  const loaded = reduceSave(initialSaveState(), { type: "load", value: false });
  const saving = start(loaded, true);
  assert.equal(saving.value, true, "the control moves immediately");
  assert.equal(saving.previous, false);
  assert.equal(saving.saving, true);
});

test("the newest response wins and a stale ok is ignored", () => {
  let state = reduceSave(initialSaveState(), { type: "load", value: "off" });
  state = start(state, "standard"); // token 1
  const firstToken = state.token;
  state = start(state, "conservative"); // token 2
  const secondToken = state.token;

  const stale = reduceSave(state, { type: "ok", token: firstToken, value: "standard" });
  assert.equal(stale.value, "conservative", "an older answer must not overwrite the newer pick");
  assert.equal(stale.saving, true, "the newer save is still in flight");

  const fresh = reduceSave(stale, { type: "ok", token: secondToken, value: "conservative" });
  assert.equal(fresh.saving, false);
  assert.equal(fresh.saved, true);
});

test("a failure restores the previous value, and a stale failure changes nothing", () => {
  let state = reduceSave(initialSaveState(), { type: "load", value: "standard" });
  state = start(state, "off"); // token 1
  const staleToken = state.token;
  state = start(state, "conservative"); // token 2

  const staleFail = reduceSave(state, { type: "fail", token: staleToken });
  assert.equal(staleFail.value, "conservative", "the newer pick stays on screen");
  assert.equal(staleFail.failed, false);

  const realFail = reduceSave(staleFail, { type: "fail", token: staleFail.token });
  assert.equal(realFail.value, "standard", "the refused value is rolled back");
  assert.equal(realFail.saving, false);
  assert.equal(realFail.failed, true);
});

test("the save after a failure starts clean and can succeed", () => {
  let state = reduceSave(initialSaveState(), { type: "load", value: "off" });
  state = start(state, "standard");
  state = reduceSave(state, { type: "fail", token: state.token });
  assert.equal(state.failed, true);

  state = start(state, "standard");
  assert.equal(state.failed, false, "a retry clears the failure note");
  assert.equal(state.saving, true);
  state = reduceSave(state, { type: "ok", token: state.token, value: "standard" });
  assert.equal(state.value, "standard");
  assert.equal(state.saved, true);
  assert.equal(state.failed, false);
});

test("the saved note expires on its own", () => {
  let state = reduceSave(initialSaveState(), { type: "load", value: true });
  state = start(state, false);
  state = reduceSave(state, { type: "ok", token: state.token, value: false });
  assert.equal(state.saved, true);
  assert.equal(reduceSave(state, { type: "saved-expired" }).saved, false);
});

test("a read failure is reported without freezing the row", () => {
  const state = reduceSave(initialSaveState(), { type: "read-failed" });
  assert.equal(state.failed, true);
  assert.equal(state.saving, false);
  assert.equal(state.value, null, "the row still shows its fallback");
});

test("a failed GET stays usable, and its first failed save returns to the fallback", () => {
  // Contract: `value === null` means "unknown, show the fallback", not "disabled".
  let state = reduceSave(initialSaveState(), { type: "read-failed" });
  assert.equal(shown(state.value, "off"), "off", "the control shows the default and can be clicked");

  state = start(state, "standard");
  assert.equal(state.previous, null, "there is no confirmed value to restore");
  state = reduceSave(state, { type: "fail", token: state.token });
  assert.equal(state.value, null);
  assert.equal(state.failed, true);
  assert.equal(shown(state.value, "off"), "off", "the row lands back on the fallback, not blank");
});

test("a save after a failed GET still becomes the new baseline", () => {
  let state = reduceSave(initialSaveState(), { type: "read-failed" });
  state = start(state, "standard");
  state = reduceSave(state, { type: "ok", token: state.token, value: "standard" });
  assert.equal(state.baseline, "standard", "one successful write recovers the row");
  assert.equal(state.failed, false);
});

test("shown() is the control's value: loaded value, else the fallback", () => {
  assert.equal(shown(null, false), false);
  assert.equal(shown(false, true), false, "false is a loaded value");
  assert.equal(shown("conservative", "off"), "conservative");
});

test("an unreadable payload reads as the stated fallback, never as undefined", () => {
  const read = (payload) => {
    const value = field(payload, "enabled");
    return typeof value === "boolean" ? value : undefined;
  };
  assert.equal(readOr({ enabled: false }, read, true), false, "false is a value, not a miss");
  assert.equal(readOr({ enabled: "yes" }, read, true), true);
  assert.equal(readOr({}, read, true), true);
  assert.equal(readOr(null, read, false), false);
});

test("field never throws on a non-object", () => {
  for (const payload of [null, undefined, "x", 7, [], {}]) {
    assert.equal(field(payload, "preset"), undefined);
  }
  assert.equal(field({ preset: "standard" }, "preset"), "standard");
});

test("both settings rows run on the shared round trip instead of their own race logic", () => {
  for (const file of ["ServerSwitchSettingRow.tsx", "FastModeSettingRow.tsx"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.match(source, /useServerSetting/, `${file} must use the shared hook`);
    assert.doesNotMatch(source, /saveSeq/, `${file} must not keep a private save counter`);
    assert.doesNotMatch(source, /fetch\(endpoint, \{/, `${file} must not PUT by hand`);
  }
});

test("the hook keeps update stable: no value in its dependency list", () => {
  const hook = readFileSync(new URL("../hooks/useServerSetting.ts", import.meta.url), "utf8");
  const update = hook.slice(hook.indexOf("const update = useCallback"), hook.indexOf("return { value:"));
  assert.match(update, /\}, \[endpoint, clearSavedLater\]\)/, "update must not rebuild on every value change");
  assert.doesNotMatch(update, /\[.*\bvalue\b.*\]/, "a value dependency would rebuild the callback each render");
});
