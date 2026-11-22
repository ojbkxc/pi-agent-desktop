import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../..", import.meta.url).pathname.replace(/\/$/, "") } });
const h = await jiti.import("./scheduled-helpers.ts");

// A translator that exposes the key and parameters so the choice of wording is visible.
const t = (key, params) => (params ? `${key}${JSON.stringify(params)}` : key);

const base = {
  id: "task", name: "n", prompt: "p", cwd: "/", schedule: { kind: "manual" }, toolPreset: "read-only",
  maxDurationMin: 30, enabled: true, createdAt: "", updatedAt: "", consecutiveFailures: 0,
  nextRunAt: null, lastRun: null, unreadRuns: 0,
};

test("schedules are described with the wording that matches their preset", () => {
  const cron = (expr) => ({ kind: "cron", expr, timezone: "UTC" });
  assert.equal(h.describeSchedule({ kind: "manual" }, t, "en"), "scheduled.describe.manual");
  assert.equal(h.describeSchedule(cron("5 * * * *"), t, "en"), 'scheduled.describe.hourly{"minute":"05"}');
  assert.equal(h.describeSchedule(cron("0 9 * * *"), t, "en"), 'scheduled.describe.daily{"time":"09:00"}');
  assert.equal(h.describeSchedule(cron("30 8 * * 1-5"), t, "en"), 'scheduled.describe.weekdays{"time":"08:30"}');
  assert.equal(h.describeSchedule(cron("0 9 * * 1"), t, "en"), 'scheduled.describe.weekly{"day":"Monday","time":"09:00"}');
  assert.equal(h.describeSchedule(cron("*/15 * * * *"), t, "en"), 'scheduled.describe.custom{"expr":"*/15 * * * *"}');
});

test("weekday names follow the locale", () => {
  const schedule = { kind: "cron", expr: "0 9 * * 0", timezone: "UTC" };
  assert.match(h.describeSchedule(schedule, t, "en"), /Sunday/);
  assert.match(h.describeSchedule(schedule, t, "zh-CN"), /星期日/);
});

test("task status prefers running, then attention, then enabled state", () => {
  const none = new Set();
  assert.equal(h.taskStatus(base, none), "manual");
  assert.equal(h.taskStatus({ ...base, schedule: { kind: "cron", expr: "0 9 * * *", timezone: "UTC" } }, none), "active");
  assert.equal(h.taskStatus({ ...base, enabled: false }, none), "paused");
  assert.equal(h.taskStatus({ ...base, enabled: false, autoPausedReason: "x" }, none), "attention");
  assert.equal(h.taskStatus({ ...base, enabled: false, autoPausedReason: "x" }, new Set(["task"])), "running");
  assert.equal(h.taskStatus({ ...base, lastRun: { runId: "r", taskId: "task", trigger: "manual", status: "running" } }, none), "running");
  assert.equal(h.taskStatus({ ...base, enabled: false, schedule: { kind: "once", at: "2026-10-07T09:00:00Z" }, lastRun: { runId: "r", taskId: "task", trigger: "schedule", status: "succeeded" } }, none), "done");
});

test("durations read naturally", () => {
  assert.equal(h.formatDuration(4200), "4s");
  assert.equal(h.formatDuration(185_000), "3m 05s");
  assert.equal(h.formatDuration(3_720_000), "1h 02m");
  assert.equal(h.formatDuration(-5), "0s");
  assert.equal(h.runDuration({ startedAt: "2026-10-07T09:00:00Z", endedAt: "2026-10-07T09:00:42Z" }), 42_000);
  assert.equal(h.runDuration({ startedAt: "2026-10-07T09:00:00Z" }), null);
});

test("only a finished run with a session the user has not opened is unread", () => {
  const run = { runId: "r", taskId: "t", trigger: "manual", status: "succeeded", sessionId: "s" };
  assert.equal(h.isUnread(run), true);
  assert.equal(h.isUnread({ ...run, seenAt: "2026-10-07T10:00:00Z" }), false);
  assert.equal(h.isUnread({ ...run, status: "running" }), false);
  assert.equal(h.isUnread({ ...run, status: "skipped" }), false);
  assert.equal(h.isUnread({ ...run, sessionId: undefined }), false);
});

test("local datetime values round-trip through an instant", () => {
  const iso = "2026-10-07T09:30:00.000Z";
  assert.equal(h.fromLocalInputValue(h.toLocalInputValue(iso)), iso);
  assert.equal(h.fromLocalInputValue("not a date"), null);
});

test("only the presets that can change files are flagged as writing", () => {
  assert.deepEqual(["none", "read-only", "default", "full"].map(h.canWrite), [false, false, true, true]);
});

test("a cron preview only counts for the expression it was computed from", () => {
  // interaction.md P2：预览必须与表达式绑定。旧实现只存 CronPreview 本身，表达式
  // 改成非法值后、新预览返回前，界面仍展示旧表达式的 next runs 并用旧结果判合法。
  const stale = { expr: "*/5 * * * *", result: { valid: true, nextRuns: ["2026-11-18T00:05:00Z"] } };

  // 表达式变了：旧预览既不能展示，也不能放行提交；此时处于「校验中」。
  assert.deepEqual(h.bindCronPreview("* * * *", stale), { shown: null, pending: true, invalid: false, failed: false, errorMessage: null });

  // 表达式一致：合法预览可展示、无 pending、不算非法。
  assert.deepEqual(h.bindCronPreview("*/5 * * * *", stale), {
    shown: stale.result,
    pending: false,
    invalid: false,
    failed: false,
    errorMessage: null,
  });

  // 一致但非法：不允许提交。
  const invalidPreview = { expr: "* * * *", result: { valid: false, error: "bad" } };
  assert.deepEqual(h.bindCronPreview("* * * *", invalidPreview), {
    shown: invalidPreview.result,
    pending: false,
    invalid: true,
    failed: false,
    errorMessage: null,
  });

  // 非 cron 表单（expr 为 null）：没有预览，也不算 pending/非法。
  assert.deepEqual(h.bindCronPreview(null, stale), { shown: null, pending: false, invalid: false, failed: false, errorMessage: null });
});

test("cron 预览请求失败：failed + 错误文案，且仍 pending（禁止提交、不卡在「检查中」）", () => {
  const previewError = { expr: "* * * * *", message: "Network down" };
  assert.deepEqual(h.bindCronPreview("* * * * *", null, previewError), {
    shown: null,
    pending: true,
    invalid: false,
    failed: true,
    errorMessage: "Network down",
  });
  // 旧表达式的错误不算数：当前表达式仍按「检查中/待校验」处理，不显示旧错误。
  assert.deepEqual(h.bindCronPreview("*/5 * * * *", null, previewError), {
    shown: null,
    pending: true,
    invalid: false,
    failed: false,
    errorMessage: null,
  });
});
