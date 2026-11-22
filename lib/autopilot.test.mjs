import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  AUTOPILOT_DEFAULTS,
  AUTOPILOT_DIALOG_TIMEOUT_MS,
  AUTOPILOT_SESSION_MARKERS,
  MAX_AUTOPILOT_FIX_ROUNDS,
  isAutopilotDialogSession,
  isAutopilotOriginatedSession,
  readAutopilotSettings,
  resolveAutopilotDialogTimeout,
  writeAutopilotSettings,
  isAutopilotEnabled,
} = await jiti.import("./autopilot.ts");
const { AUTOFIX_MAX_ROUNDS } = await jiti.import("./autofix/types.ts");
const { shouldAutoApprove } = await jiti.import("./agent-teams-autopilot.ts");

const dir = await mkdtemp(join(tmpdir(), "pi-web-autopilot-"));
after(async () => { await rm(dir, { recursive: true, force: true }); });
const settingsPath = () => join(dir, `settings-${Math.random().toString(16).slice(2)}.json`);

test("默认：开启，子开关为安全默认值", () => {
  const settings = readAutopilotSettings(settingsPath());
  assert.equal(settings.enabled, true, "无人值守默认开启（用户要求）");
  assert.equal(settings.autoApproveTeamPlans, true);
  assert.equal(settings.autoFixFailedRuns, true);
  assert.equal(settings.maxAutoFixRounds, AUTOPILOT_DEFAULTS.maxAutoFixRounds);
  assert.equal(isAutopilotEnabled(settingsPath()), true);
});

test("写入后读回；部分更新不影响其他字段", () => {
  const path = settingsPath();
  const written = writeAutopilotSettings({ enabled: true, maxAutoFixRounds: 3 }, path);
  assert.equal(written.enabled, true);
  assert.equal(written.maxAutoFixRounds, 3);
  assert.equal(written.autoFixFailedRuns, true, "未传的字段保持默认");

  const partial = writeAutopilotSettings({ autoFixFailedRuns: false }, path);
  assert.equal(partial.enabled, true, "已有值保留");
  assert.equal(partial.autoFixFailedRuns, false);
  assert.equal(readAutopilotSettings(path).enabled, true);
});

test("损坏/非对象设置回落到默认（开启）", async () => {
  const path = settingsPath();
  await writeFile(path, "{not json", "utf8");
  const settings = readAutopilotSettings(path);
  assert.equal(settings.enabled, true);
  assert.equal(settings.autoFixFailedRuns, true);
});

test("maxAutoFixRounds 边界：0 / 超上限 / 非整数拒绝", () => {
  const path = settingsPath();
  for (const bad of [0, -1, MAX_AUTOPILOT_FIX_ROUNDS + 1, 1.5, Number.NaN]) {
    assert.throws(() => writeAutopilotSettings({ maxAutoFixRounds: bad }, path), RangeError, String(bad));
  }
  const ok = writeAutopilotSettings({ maxAutoFixRounds: MAX_AUTOPILOT_FIX_ROUNDS }, path);
  assert.equal(ok.maxAutoFixRounds, MAX_AUTOPILOT_FIX_ROUNDS);
});

test("轮次上限必须与 autofix 引擎一致，否则建任务被拒后静默不修", () => {
  assert.equal(
    MAX_AUTOPILOT_FIX_ROUNDS,
    AUTOFIX_MAX_ROUNDS,
    "autopilot 接受的值必须能通过 createAutofixTask 的校验",
  );
});

test("已落盘的超引擎上限值读取时忽略，回落到默认", async () => {
  const path = settingsPath();
  await writeFile(
    path,
    JSON.stringify({ autopilot: { enabled: true, maxAutoFixRounds: AUTOFIX_MAX_ROUNDS + 1 } }),
    "utf8",
  );
  const settings = readAutopilotSettings(path);
  assert.equal(settings.maxAutoFixRounds, AUTOPILOT_DEFAULTS.maxAutoFixRounds);
});

test("只有 scheduled / autofix 的后代会话算无人值守会话", () => {
  for (const marker of AUTOPILOT_SESSION_MARKERS) {
    assert.equal(isAutopilotOriginatedSession([marker]), true, marker);
  }
  assert.equal(isAutopilotOriginatedSession(["pi-web:subagent", "pi-web:autofix"]), true);
  assert.equal(isAutopilotOriginatedSession(["pi-web:subagent"]), false);
  assert.equal(isAutopilotOriginatedSession([]), false);
});

test("阻塞对话框：扩展自带的 timeout 优先；无人值守会话在总开关下拿默认超时", () => {
  const on = { ...AUTOPILOT_DEFAULTS, enabled: true };
  const off = { ...AUTOPILOT_DEFAULTS, enabled: false };

  assert.equal(
    resolveAutopilotDialogTimeout({ requested: 5_000, autopilotSession: true, settings: on }),
    5_000,
    "扩展自己设的超时不覆盖",
  );
  assert.equal(
    resolveAutopilotDialogTimeout({ autopilotSession: true, settings: on }),
    AUTOPILOT_DIALOG_TIMEOUT_MS,
  );
  assert.equal(resolveAutopilotDialogTimeout({ autopilotSession: true, settings: off }), undefined);
  assert.equal(resolveAutopilotDialogTimeout({ autopilotSession: false, settings: on }), undefined, "手动会话不自动应答");
});

test("campaign 对话框取安全默认，但不进 markers、不自动批准计划（窄口径）", () => {
  assert.equal(isAutopilotDialogSession(["pi-web:campaign"]), true, "campaign 无人值守，对话框要拿超时");
  assert.equal(isAutopilotDialogSession(["pi-web:autofix"]), true);
  assert.equal(isAutopilotDialogSession(["pi-web:scheduled-run"]), true);
  assert.equal(isAutopilotDialogSession(["pi-web:subagent"]), false, "普通会话仍无限等待");

  // 窄口径：MARKERS 不含 campaign ⇒ 计划自动批准保持 false，不误扩。
  assert.equal(AUTOPILOT_SESSION_MARKERS.includes("pi-web:campaign"), false);
  assert.equal(isAutopilotOriginatedSession(["pi-web:campaign"]), false);
  assert.equal(
    shouldAutoApprove({ ...AUTOPILOT_DEFAULTS, enabled: true, autoApproveTeamPlans: true }, ["pi-web:campaign"]),
    false,
    "campaign 不得自动批准团队计划",
  );

  assert.equal(
    resolveAutopilotDialogTimeout({
      autopilotSession: isAutopilotDialogSession(["pi-web:campaign"]),
      settings: { ...AUTOPILOT_DEFAULTS, enabled: true },
    }),
    AUTOPILOT_DIALOG_TIMEOUT_MS,
    "campaign 阻塞对话框拿到 120s 安全默认",
  );
});
