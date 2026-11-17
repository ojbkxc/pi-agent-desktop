import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// `!important` 存量基线：冻结增量，不要求清零。
//
// 背景（test-results/detail-audit/css.md #9）：`app/native-theme.css` 里
// `!important` 一度有 396 处（上游菜单类 `.native-popover button:hover` /
// `.app-menu :is(...)` 与 fork 覆盖互相加码），css 审计的两条 P1/P2 缺陷
// （主按钮 hover 白字、file-filter 焦点环被抹）都是它「一次误写即永久生效」
// 的直接产物。一次大规模重构风险高于收益（且会与上游合并冲突），因此这里
// 只做一件事：**冻结当前数量**，新规则不得再加 `!important`。
//
// 基线说明：数字按本次修复（删死 CSS + 收口焦点环 + 前景 token）后的实际值
// 写死，不沿用审计时的 396。若你确需降低它（删规则/降级特异性），把
// BASELINE 调小即可；调大必须在 PR 说明里解释为什么非加不可。

const BASELINE = 365;

const css = readFileSync(fileURLToPath(new URL("../app/native-theme.css", import.meta.url)), "utf8");

test("native-theme.css 的 !important 数量不超过冻结基线", () => {
  const count = (css.match(/!important/g) ?? []).length;
  assert.ok(
    count <= BASELINE,
    `app/native-theme.css 新增了 ${count - BASELINE} 处 !important（当前 ${count}，基线 ${BASELINE}）。`
      + "请优先用特异性（显式子选择器、:where() 之外）解决，而不是 !important。",
  );
});

test("文件顶部写明了「新规则禁止新增 !important」的规则", () => {
  const head = css.slice(0, 1200);
  assert.match(head, /新增规则禁止再写\s*`?!important`?/, "顶部注释必须保留这条规则，供后续维护者看到");
});
