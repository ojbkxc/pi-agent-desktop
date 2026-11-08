import assert from "node:assert/strict";
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
