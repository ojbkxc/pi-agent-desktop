import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * 「扩展面板别再弹了，默认永久允许」的判据。
 *
 * 自动作答只在**能确定「允许」是什么意思**的形态上发生：
 * confirm 答 true；select 只在选项文本明确表达允许时才自动选；input / editor /
 * custom 一律不代答（空串不是允许，自绘面板没有可编程答案）。
 *
 * 三条不能丢的边界：默认开着但**可关**、每次自动作答**留审计日志**、
 * 措辞里没有允许语义的 select **仍然弹出**（替用户在业务选项里挑一个不是允许，是猜）。
 */
const root = mkdtempSync(join(tmpdir(), "pi-ext-ui-"));
const settingsPath = join(root, "settings.json");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const ui = await jiti.import("./extension-ui-settings.ts");

after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

test("auto-allow ships on, and a read of a missing file keeps it on", () => {
  assert.equal(ui.EXTENSION_UI_AUTO_ALLOW_DEFAULT, true);
  assert.deepEqual(ui.readExtensionUiSettings(settingsPath), { autoAllow: true });
});

test("confirm is answered with `true` without any popping up", () => {
  assert.deepEqual(ui.autoAllowAnswer({ method: "confirm", title: "Allow the extension to read files?" }), { kind: "confirm" });
});

test("input, editor and custom panels are never auto-answered", () => {
  for (const method of ["input", "editor", "custom", "notify"]) {
    assert.equal(ui.autoAllowAnswer({ method, title: "x" }), undefined, `${method} must still be shown`);
  }
  // An unknown/new method is not guessed either.
  assert.equal(ui.autoAllowAnswer({ method: "brand-new", title: "x" }), undefined);
});

test("select auto-answers only when an option clearly means `allow`", () => {
  // Plain string options.
  assert.deepEqual(ui.autoAllowAnswer({ method: "select", title: "t", options: ["Allow", "Deny"] }), { kind: "select", label: "Allow" });
  assert.deepEqual(ui.autoAllowAnswer({ method: "select", title: "t", options: ["yes", "no"] }), { kind: "select", label: "yes" });
  assert.deepEqual(ui.autoAllowAnswer({ method: "select", title: "t", options: ["允许一次", "拒绝"] }), { kind: "select", label: "允许一次" });
  // {value,label} options carry their value through.
  assert.deepEqual(
    ui.autoAllowAnswer({ method: "select", title: "t", options: [{ value: "a1", label: "Approve anyway" }, { value: "d1", label: "Skip" }] }),
    { kind: "select", label: "a1" },
  );
  // No allow-like wording → still shown to the user (choosing a business option is a guess).
  assert.equal(ui.autoAllowAnswer({ method: "select", title: "t", options: ["postgres", "mysql"] }), undefined);
  assert.equal(ui.autoAllowAnswer({ method: "select", title: "t", options: [] }), undefined);
  assert.equal(ui.autoAllowAnswer({ method: "select", title: "t" }), undefined);
});

test("the switch is a real setting: off is persisted and read back", () => {
  ui.writeExtensionUiAutoAllow(false, settingsPath);
  assert.deepEqual(ui.readExtensionUiSettings(settingsPath), { autoAllow: false });
  ui.writeExtensionUiAutoAllow(true, settingsPath);
  assert.deepEqual(ui.readExtensionUiSettings(settingsPath), { autoAllow: true });
});

test("a corrupted settings file falls back to on, not to popping up again", () => {
  const broken = join(root, "broken.json");
  writeBroken(broken);
  assert.deepEqual(ui.readExtensionUiSettings(broken), { autoAllow: true });
});

function writeBroken(path) {
  writeFileSync(path, "{not json", "utf8");
}
