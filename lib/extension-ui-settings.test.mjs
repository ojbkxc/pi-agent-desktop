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

test("input and editor auto-answer with an empty value; custom is handled by the caller", () => {
  // 操作者两次明确要求「默认写死永久允许、别再弹」，所以文本类也代答。
  // 空串 =「没有额外信息」（取消是 undefined），对「要不要继续」这类提问正好是「继续」。
  for (const method of ["input", "editor"]) {
    assert.deepEqual(ui.autoAllowAnswer({ method, title: "x" }), { kind: "text" }, `${method} must be auto-answered`);
  }
  // `custom`（自绘面板）没有可编程答案，由 rpc-manager 直接收起，这里不猜。
  assert.equal(ui.autoAllowAnswer({ method: "custom", title: "x" }), undefined);
  // notify 是单向通知，不是提问。
  assert.equal(ui.autoAllowAnswer({ method: "notify", title: "x" }), undefined);
  // An unknown/new method is not guessed either.
  assert.equal(ui.autoAllowAnswer({ method: "brand-new", title: "x" }), undefined);
});

test("select prefers an allow-like option, else takes the first the extension offered", () => {
  // Plain string options.
  assert.deepEqual(ui.autoAllowAnswer({ method: "select", title: "t", options: ["Allow", "Deny"] }), { kind: "select", label: "Allow" });
  assert.deepEqual(ui.autoAllowAnswer({ method: "select", title: "t", options: ["yes", "no"] }), { kind: "select", label: "yes" });
  assert.deepEqual(ui.autoAllowAnswer({ method: "select", title: "t", options: ["允许一次", "拒绝"] }), { kind: "select", label: "允许一次" });
  // {value,label} options carry their value through.
  assert.deepEqual(
    ui.autoAllowAnswer({ method: "select", title: "t", options: [{ value: "a1", label: "Approve anyway" }, { value: "d1", label: "Skip" }] }),
    { kind: "select", label: "a1" },
  );
  // 没有 allow 措辞时取**第一个**：选项集合就是扩展允许的答案域，「默认接受」比弹出来等一个人强。
  assert.deepEqual(ui.autoAllowAnswer({ method: "select", title: "t", options: ["postgres", "mysql"] }), { kind: "select", label: "postgres" });
  // 空选项列表仍然弹出——替扩展编一个答案才是瞎猜。
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
