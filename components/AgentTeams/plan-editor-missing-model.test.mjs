import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 成员模型仍为空时必须告警（团队计数审计 P2-1）。
 *
 * 现象：模型栏显示「未设置」，用户以为是「跟随主模型、不用管」，直接点批准——团队启动后
 * 那个成员 spawn 失败，界面全程没有一句话。`isApproveDisabled` 不看 runtime，所以批准照常放行。
 *
 * 口径：**只提示、不拦批准**。真实机器上队长 runtime 恒为 `unknown/unknown`，硬拦会把最
 * 常见的正常流程挡死；而且有了主模型预填之后，这种情况只剩「本机完全没配模型」。
 */
const editor = readFileSync(new URL("./PlanEditor.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const messages = readFileSync(new URL("../../lib/i18n/locale-plugins.ts", import.meta.url), "utf8");
test("the editor lists members whose model is still empty", () => {
  assert.match(editor, /const missingModelMembers = useMemo\(/, "the list is derived from the draft");
  assert.match(editor, /!isUsableModelRef\(draft\.members\[member\.id\]\?\.modelRef \?\? ""\)/, "an empty model is the signal");
  assert.match(editor, /data-testid="team-plan-missing-model"/, "and it renders a warning");
  assert.match(editor, /t\("teams\.plan\.missingModel", \{ names: missingModelMembers\.join\("、"\) \}\)/);
});

test("the warning is advisory: it does not disable approving", () => {
  // 只有告警，没有把 missingModelMembers 塞进任何 disabled 表达式（那会挡掉正常流程）。
  assert.doesNotMatch(editor, /disabled=\{[^}]*missingModelMembers/);
});

test("the warning text exists in all three locales", () => {
  const hits = messages.match(/"teams\.plan\.missingModel": "\S/g) ?? [];
  assert.equal(hits.length, 3, `en / zh-CN / zh-TW must all carry it, found ${hits.length}`);
});
