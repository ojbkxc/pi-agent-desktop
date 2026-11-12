import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { detectBashPath, withWindowsBashFallback } = await jiti.import("./windows-bash-fallback.ts");

function fakeSettings(shellPath) {
  const calls = [];
  return {
    calls,
    getShellPath: () => shellPath,
    getCompactionSettings: (model) => ({ model, reserveTokens: 1 }),
    save: () => calls.push("save"),
    value: 42,
  };
}

test("an explicit shellPath is never overridden", () => {
  const base = fakeSettings("C:\\explicit\\bash.exe");
  assert.equal(withWindowsBashFallback(base, "win32"), base, "已有配置时原样返回（不包装）");
});

test("off Windows the wrapper is a no-op", () => {
  const base = fakeSettings(undefined);
  assert.equal(withWindowsBashFallback(base, "darwin"), base);
  assert.equal(withWindowsBashFallback(base, "linux"), base);
});

test("a detected bash fills in an absent shellPath; other members pass through with stable identity", () => {
  const base = fakeSettings(undefined);
  const wrapped = withWindowsBashFallback(base, "win32");
  if (wrapped === base) {
    // 本机没有 bash：探测返回 null 时也不该包装（不编造路径）。
    assert.equal(detectBashPath("win32"), null);
    return;
  }
  const detected = detectBashPath("win32");
  assert.ok(detected, "wrap 了却没有探测到路径");
  assert.equal(wrapped.getShellPath(), detected);
  assert.equal(wrapped.value, 42, "属性透传");
  assert.equal(typeof wrapped.save, "function");
  assert.equal(wrapped.save, wrapped.save, "方法身份稳定（不能每次返回新函数）");
  wrapped.save();
  assert.deepEqual(base.calls, ["save"], "写入落到原对象");
  assert.notEqual("" + wrapped.getCompactionSettings, "", "其余方法透传");
  assert.equal(wrapped.getCompactionSettings("m").reserveTokens, 1);
});

test("detectBashPath off Windows is always null", () => {
  assert.equal(detectBashPath("darwin"), null);
  assert.equal(detectBashPath("linux"), null);
});