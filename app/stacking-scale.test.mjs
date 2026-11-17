import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 层级刻度：`app/native-theme.css` 的 :root 区块是**唯一**锚点。
// 覆盖层被遮挡的两次事故都源于这里：祖先层叠上下文把后代封顶（`.scheduled-view` 的
// --z-sticky=30 盖不过顶栏 --z-chrome=90），以及某层浮到不该到的位置（项目菜单用了
// 对话框层，盖住已打开的设置）。这类错误在浏览器里才看得见，CI 里没有渲染环境，所以
// 这里退回最便宜的一道闸：**钉住刻度值与相对次序**，并钉住几个已知的落点选择。
// 真正「计算后谁盖住谁」仍需 `test-results/overlay-audit/overlay-audit.mjs` 那种浏览器实测。

const css = readFileSync(fileURLToPath(new URL("../app/native-theme.css", import.meta.url)), "utf8");

/** 从 :root 块里取 `--z-*` 的像素值。 */
function stackingScale() {
  const start = css.indexOf("--z-sticky:");
  assert.ok(start > 0, "--z-sticky must exist");
  const block = css.slice(start, css.indexOf("}", start));
  const scale = {};
  for (const match of block.matchAll(/(--z-[\w-]+)\s*:\s*(\d+)\s*;/g)) {
    scale[match[1]] = Number(match[2]);
  }
  return scale;
}

test("stacking scale keeps its documented order, lowest first", () => {
  const scale = stackingScale();
  assert.deepEqual(scale, {
    "--z-sticky": 30,
    "--z-chrome": 90,
    "--z-dropdown": 120,
    "--z-popover": 650,
    "--z-modal": 1000,
    "--z-modal-nested": 1100,
    "--z-toast": 1200,
    "--z-menu": 2400,
  });
  // 次序本身就是语义：菜单必须高于对话框（对话框内开选项菜单），toast 必须高于对话框。
  const order = Object.entries(scale).sort((a, b) => a[1] - b[1]).map(([name]) => name);
  assert.deepEqual(order, [
    "--z-sticky", "--z-chrome", "--z-dropdown", "--z-popover",
    "--z-modal", "--z-modal-nested", "--z-toast", "--z-menu",
  ]);
});

/** 取某个选择器规则体里 z-index 的声明值（原样字符串）。 */
function zIndexOf(selector) {
  const pattern = new RegExp(`(?:^|\\n)${selector.replace(/[.[\]"%]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const match = pattern.exec(css);
  assert.ok(match, `${selector} rule must exist`);
  const zIndex = /z-index:\s*([^;]+);/.exec(match[1]);
  assert.ok(zIndex, `${selector} must declare z-index`);
  return zIndex[1].trim();
}

test("dialogs sit on the dialog layer, anchor menus sit below it", () => {
  // 真模态：必须在 --z-modal（设置对话框同层）。曾经各自用 literal 750 / --z-chrome。
  assert.equal(zIndexOf(".shortcut-help-backdrop"), "var(--z-modal)");
  assert.equal(zIndexOf(".project-picker-modal-overlay"), "var(--z-modal)");
  // Scheduled 页的删除确认：曾用 literal 400（只决定 .scheduled-view 页内次序）。
  assert.equal(zIndexOf(".scheduled-dialog-backdrop"), "var(--z-modal)");
  // 锚定菜单：不能盖住已打开的设置对话框（曾用 --z-modal，浮在设置之上）。
  assert.equal(zIndexOf(".sidebar-project-context-menu"), "var(--z-popover)");
  assert.equal(zIndexOf(".project-view-menu"), "var(--z-popover)");
});

test("no dialog reads an undefined layer variable", () => {
  // `--z-drawer` 曾在一处使用但全仓未定义，静默退到 fallback 40（低于顶栏 90）。
  assert.doesNotMatch(css, /--z-drawer/);
});

test("the model panel and the task drawer do not reintroduce literal layers", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../components/AgentTeams/AgentTeamTaskDetail.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(source, /zIndex:\s*"var\(--z-popover\)"/, "抽屉用 popover 层（>顶栏 90）");
  assert.doesNotMatch(source, /zIndex:\s*\d/, "抽屉不得用 literal z-index");
  assert.doesNotMatch(source, /z-drawer/, "未定义变量不得回流");
});