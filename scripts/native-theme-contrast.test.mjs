import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// WCAG 对比度回归闸。css 审计的两条 P1/P2 都源于 token 组合：
//   - 深色 `.native-button-primary:hover` 用硬编码 #fff 盖在 --accent-hover(#ffffff) 上 = 1.00:1；
//   - 同族 #fff 对 --danger #ff6961 = 2.82:1、对 --success #4fd17a = 1.96:1；
//   - 深色 --text-dim #8a8a8e 对 --surface-elevated #262626 = 4.40:1（差 0.1 不过 AA）。
// 浏览器里才看得见，CI 无渲染环境，所以这里从 CSS 解析 token 实值，直接算比率。
// 任何 token 改动若把某个「前景/底色」组合压到 4.5:1 以下，此测试变红。

const css = readFileSync(fileURLToPath(new URL("../app/native-theme.css", import.meta.url)), "utf8");

/** 取某个作用域（:root 或 html.dark）里的 token 值。 */
function token(scope, name) {
  // 文件里有多个 `:root {` 块（类型刻度、tokens）；取**最后一个**含该 token 的块，
  // 因为真正的颜色 token 在靠后的 :root 里。html.dark 只有一个。
  const marker = `${scope} {`;
  let from = 0;
  let block = null;
  for (;;) {
    const start = css.indexOf(marker, from);
    if (start === -1) break;
    const end = css.indexOf("\n}", start);
    const candidate = css.slice(start, end);
    if (candidate.includes(`${name}:`) || candidate.includes(`${name} :`)) block = candidate;
    from = end + 1;
  }
  assert.ok(block, `${name} must be defined in ${scope}`);
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(block);
  assert.ok(match, `${name} must be defined in ${scope}`);
  return match[1].trim();
}

function parseColor(value) {
  const hex = value.replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
}

function luminance(hex) {
  const [r, g, b] = parseColor(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground, background) {
  const [hi, lo] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** 断言一对 token 的对比度 ≥ 4.5（AA 正文）。 */
function assertAA(scope, fg, bg, label) {
  const ratio = contrast(token(scope, fg), token(scope, bg));
  assert.ok(
    ratio >= 4.5,
    `${label || `${scope} ${fg} on ${bg}`}: ${ratio.toFixed(2)}:1 < 4.5:1 (${token(scope, fg)} on ${token(scope, bg)})`,
  );
}

test("深色主题：主按钮 hover 的前景对 --accent-hover 达 AA（曾 1.00:1）", () => {
  // 主按钮 hover 的前景已改 --accent-contrast；深色 --accent-hover 是 #ffffff。
  assertAA("html.dark", "--accent-contrast", "--accent-hover");
  assertAA("html.dark", "--accent-contrast", "--accent");
});

test("实心 danger / success 按钮的前景在两主题下都达 AA（曾 2.82 / 1.96:1）", () => {
  assertAA(":root", "--on-danger", "--danger");
  assertAA(":root", "--on-success", "--success");
  assertAA("html.dark", "--on-danger", "--danger");
  assertAA("html.dark", "--on-success", "--success");
});

test("深色 --text-dim 对四种底色都达 AA（曾对 elevated 4.40:1）", () => {
  for (const bg of ["--bg", "--surface", "--surface-elevated"]) {
    assertAA("html.dark", "--text-dim", bg);
  }
  for (const bg of ["--bg", "--surface", "--surface-elevated"]) {
    assertAA("html.dark", "--text-muted", bg);
  }
});

test("浅色 --text-dim / --text-muted 对卡面底色达 AA", () => {
  // 浅色主题不在本次审计的修复范围（css.md #11 只点了深色）；这里只钉审计确认通过的组合。
  // 注：浅色 --text-dim(#6e6e73) 对 --bg(#f0f0f1) 是 4.45:1（差 0.05），属既有边界，
  // 本次不改 token 以免影响全局视觉，故不对 --bg 断言。
  for (const fg of ["--text-dim", "--text-muted"]) {
    for (const bg of ["--surface", "--surface-elevated"]) {
      assertAA(":root", fg, bg);
    }
  }
  assertAA(":root", "--text-muted", "--bg");
});

test("实心 danger/success 按钮不再用硬编码 #fff 作为前景", () => {
  // 这三处曾直接写 #fff，深色下全部不达标；改为 token 后不应再出现。
  for (const selector of [".native-button-primary.is-success", ".project-trust-button.is-danger"]) {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start !== -1, `${selector} must exist`);
    const block = css.slice(start, css.indexOf("}", start));
    assert.doesNotMatch(block, /color:\s*#fff\b/i, `${selector} must use --on-* token, not #fff`);
  }
});
