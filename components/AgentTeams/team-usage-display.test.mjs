import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
});
const {
  formatTeamBytes,
  formatTeamActivityDate,
  shouldNoticeIdleTeam,
  hasDisplayableUsage,
} = await jiti.import("./team-usage-display.ts");

test("formatTeamBytes：B/KB/MB/GB 进制正确；null/负值/非法一律 null（不编造）", () => {
  assert.equal(formatTeamBytes(0), "0 B");
  assert.equal(formatTeamBytes(1023), "1023 B");
  assert.equal(formatTeamBytes(1024), "1.0 KB");
  assert.equal(formatTeamBytes(1536), "1.5 KB");
  assert.equal(formatTeamBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatTeamBytes(3.5 * 1024 * 1024 * 1024), "3.5 GB");
  assert.equal(formatTeamBytes(null), null);
  assert.equal(formatTeamBytes(undefined), null);
  assert.equal(formatTeamBytes(-1), null);
  assert.equal(formatTeamBytes(Number.NaN), null);
});

test("formatTeamActivityDate：epoch ms → 指定 locale 日期；null/非法/0 → null", () => {
  // 1762560000000 = 2025-11-08（Asia/Shanghai），en-US medium 形态。
  assert.equal(formatTeamActivityDate(1762560000000, "en-US"), "Nov 8, 2025");
  assert.equal(formatTeamActivityDate(null, "en-US"), null);
  assert.equal(formatTeamActivityDate(undefined, "en-US"), null);
  assert.equal(formatTeamActivityDate(0, "en-US"), null);
  assert.equal(formatTeamActivityDate(-5, "en-US"), null);
  assert.equal(formatTeamActivityDate(Number.NaN, "en-US"), null);
});

test("shouldNoticeIdleTeam：ended 严格 true 且 idleDays>=7 才提示；false/null/=6 都不提示", () => {
  assert.equal(shouldNoticeIdleTeam({ ended: true, idleDays: 7 }), true);
  assert.equal(shouldNoticeIdleTeam({ ended: true, idleDays: 30 }), true);
  assert.equal(shouldNoticeIdleTeam({ ended: true, idleDays: 6 }), false);
  assert.equal(shouldNoticeIdleTeam({ ended: false, idleDays: 30 }), false);
  // ended=null 是「无法判定」，不能编造成已结束。
  assert.equal(shouldNoticeIdleTeam({ ended: null, idleDays: 30 }), false);
  assert.equal(shouldNoticeIdleTeam({ ended: true, idleDays: null }), false);
  assert.equal(shouldNoticeIdleTeam({ ended: true }), false);
  assert.equal(shouldNoticeIdleTeam(undefined), false);
  // 阈值可注入（T6 判别：=7 当天即提示，=6 不提示——由默认阈值 7 保证）。
  assert.equal(shouldNoticeIdleTeam({ ended: true, idleDays: 2 }, 2), true);
  assert.equal(shouldNoticeIdleTeam({ ended: true, idleDays: 1 }, 2), false);
});

test("hasDisplayableUsage：字段缺失/空对象不渲染（不编造）；usageError 本身就是可展示内容", () => {
  assert.equal(hasDisplayableUsage(undefined), false);
  assert.equal(hasDisplayableUsage({}), false);
  assert.equal(hasDisplayableUsage({ bytes: null }), true, "bytes:null + 无 usageError 不算编造，但 route 契约下必带 usageError");
  assert.equal(hasDisplayableUsage({ usageError: "du failed" }), true);
  assert.equal(hasDisplayableUsage({ bytes: 1024, files: 3 }), true);
  assert.equal(hasDisplayableUsage({ truncated: true }), true);
});

// ── #66 复核返工判别回归：客户端模块图不得带入 Node 依赖 ──────────────────
// REJECT 机制：team-usage-display.ts 曾 import lib/agent-teams-team-usage.ts，
// 其顶层 node:fs/promises、node:path 随 @/ 别名进入 "use client" 图，esbuild
// browser 与 Next webpack 双证据报不可解析。以下两条分别用「真 bundle」与
// 「静态 import 图」钉死，旧写法（回引 team-usage.ts）两条都必红。

test("esbuild browser 真判别：本模块可独立 bundle（旧实现引 node:fs 链必红）", async () => {
  const esbuild = await import("esbuild");
  const result = await esbuild.build({
    entryPoints: [new URL("./team-usage-display.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    tsconfig: new URL("../../tsconfig.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    logLevel: "silent",
  });
  const bundled = result.outputFiles[0].text;
  assert.match(bundled, /TEAM_USAGE_IDLE_NOTICE_DAYS/, "阈值必须真实进入客户端产物（同源成立）");
  assert.doesNotMatch(bundled, /node:fs|node:path/, "客户端产物不得含 Node 内置引用");
});

test("import 图静态判别：本模块只允许引零 Node 依赖的共用常量模块，禁止回引 team-usage.ts", () => {
  const display = readFileSync(new URL("./team-usage-display.ts", import.meta.url), "utf8");
  // 不许再引 node-only 的 usage 实现（顶层 node:fs 会进客户端图）。
  assert.doesNotMatch(display, /from "@\/lib\/agent-teams-team-usage"/);
  // 本文件全部 import 都不得含 node: 内置。
  for (const match of display.matchAll(/from "([^"]+)"/g)) {
    assert.doesNotMatch(match[1], /^node:/, `客户端模块不得直接引 Node 内置：${match[1]}`);
  }
  // 共用常量模块必须零 import（保持客户端图安全的不变量）。
  const constants = readFileSync(new URL("../../lib/agent-teams-usage-constants.ts", import.meta.url), "utf8");
  assert.doesNotMatch(constants, /^import\b/m, "常量模块必须保持零 import");
  assert.match(constants, /TEAM_USAGE_IDLE_NOTICE_DAYS = 7/);
});
