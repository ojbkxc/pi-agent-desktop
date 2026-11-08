import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const {
  DispatchPanel,
  dispatchBody,
  outcomeText,
  idleCandidateNames,
  suggestionRowKey,
  MEMBER_NAME_PATTERN,
} = await jiti.import("./DispatchPanel.tsx");

const source = (await import("node:fs")).readFileSync(new URL("./DispatchPanel.tsx", import.meta.url), "utf8");

const t = (key, params) => {
  // 最小翻译桩：返回键名+参数标记，断言键与占位符而非具体译文（译文由 i18n 门禁管）。
  const suffix = params ? JSON.stringify(params) : "";
  return `${key}${suffix}`;
};

const assignSuggestion = {
  kind: "assign",
  ticketId: "t1",
  toMember: "worker-one",
  reason: "open and unclaimed",
};
const reassignSuggestion = {
  kind: "reassign",
  ticketId: "t2",
  assignmentId: "assign-1",
  fromMember: "ghost",
  toMember: "worker-two",
  // 后端真实契约：expectedUpdatedAt 是毫秒时间戳（number），route 校验 typeof === "number"。
  expectedUpdatedAt: 1762560000000,
  reason: "assignee not on roster",
};
const addMemberSuggestion = {
  kind: "add-member",
  ticketId: "t3",
  reason: "all busy",
};

test("dispatchBody：assign 三字段、reassign 五字段（v5 契约）、add-member 不走 assignments", () => {
  assert.deepEqual(dispatchBody(assignSuggestion, "worker-one", "req-1"), {
    clientRequestId: "req-1",
    ticketId: "t1",
    toMember: "worker-one",
  });
  assert.deepEqual(dispatchBody(reassignSuggestion, "worker-two", "req-2"), {
    clientRequestId: "req-2",
    ticketId: "t2",
    assignmentId: "assign-1",
    toMember: "worker-two",
    expectedUpdatedAt: 1762560000000,
  });
  // 真实请求体类型对齐后端 route：expectedUpdatedAt 必须是 number 毫秒（route
  // 校验 typeof !== "number" 即 409）。
  const realBody = dispatchBody(reassignSuggestion, "worker-two", "req-2");
  assert.equal(typeof realBody.expectedUpdatedAt, "number");
  assert.equal(Number.isFinite(realBody.expectedUpdatedAt), true);
  assert.equal(dispatchBody(addMemberSuggestion, "worker-one", "req-3"), null);
  // 缺 expectedUpdatedAt/assignmentId 的 reassign 拒绝构造（契约缺参不硬发）。
  assert.equal(dispatchBody({ ...reassignSuggestion, expectedUpdatedAt: undefined }, "w", "req-4"), null);
  // 接收者为空拒绝构造。
  assert.equal(dispatchBody(assignSuggestion, "", "req-5"), null);
});

test("outcomeText：五态如实渲染——woken 只写唤醒中，绝不写已执行；未知值兜底原文", () => {
  assert.match(outcomeText("injected", undefined, t), /teams\.dispatch\.outcome\.injected/);
  const woken = outcomeText("woken", undefined, t);
  assert.match(woken, /teams\.dispatch\.outcome\.woken/);
  assert.doesNotMatch(woken, /executed|已执行|已執行/);
  assert.match(outcomeText("revived", undefined, t), /teams\.dispatch\.outcome\.revived/);
  assert.match(outcomeText("buffered", undefined, t), /teams\.dispatch\.outcome\.buffered/);
  assert.match(outcomeText("failed", "boom", t), /teams\.dispatch\.outcome\.failed/);
  assert.match(outcomeText("failed", "boom", t), /boom/);
  // v5 枚举外的新值：兜底显示原文，不假成功。
  assert.equal(outcomeText("teleported", undefined, t), "teleported");
});

test("idleCandidateNames：只取 state=idle 的成员（pending 不作接收者、orphan 永不进候选）", () => {
  const workload = {
    members: [
      { name: "busy", state: "running", runningCount: 1, pendingCount: 0 },
      { name: "queued", state: "pending", runningCount: 0, pendingCount: 2 },
      { name: "free", state: "idle", runningCount: 0, pendingCount: 0 },
    ],
    orphans: [],
    suggestions: [],
    quota: { perTeamLimit: 12, globalLimit: 32, rosterWorkers: 3, globalWorkers: 3 },
  };
  assert.deepEqual(idleCandidateNames(workload), ["free"]);
  assert.deepEqual(idleCandidateNames(null), []);
});

test("suggestionRowKey 稳定：同票同派活唯一，assignmentId 变则 key 变", () => {
  assert.equal(suggestionRowKey(assignSuggestion), "assign:t1:");
  assert.equal(suggestionRowKey(reassignSuggestion), "reassign:t2:assign-1");
  assert.notEqual(
    suggestionRowKey(reassignSuggestion),
    suggestionRowKey({ ...reassignSuggestion, assignmentId: "assign-2" }),
  );
});

test("MEMBER_NAME_PATTERN：v5 成员名格式（字母/数字开头，限字母数字点横线下划线，≤64）", () => {
  assert.ok(MEMBER_NAME_PATTERN.test("worker-two"));
  assert.ok(MEMBER_NAME_PATTERN.test("W1._-x"));
  assert.doesNotMatch("-lead", MEMBER_NAME_PATTERN);
  assert.doesNotMatch("中文名", MEMBER_NAME_PATTERN);
  assert.doesNotMatch("has space", MEMBER_NAME_PATTERN);
  assert.doesNotMatch("a".repeat(65), MEMBER_NAME_PATTERN);
  assert.ok(MEMBER_NAME_PATTERN.test("a".repeat(64)));
});

test("面板静态渲染：标题/运行中禁改派说明恒在（team=null 也不崩）", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(DispatchPanel, { team: null }),
  ));
  assert.match(html, /data-testid="agent-teams-dispatch"/);
  assert.match(html, /data-testid="agent-teams-dispatch-running-note"/);
});

// 交互态（在途禁双击/failed 才有重试/skipped 无重试/409 只有刷新）由渲染流驱动的
// 分支在 renderToStaticMarkup 下不可达，用源码结构断言钉住——后续重构移错分支即红。
test("源码钉法：在途禁双击、仅 failed 有重试、conflict 只有刷新、skipped 无重试", () => {
  // 在途：执行按钮与重试按钮都受 inFlight 禁用。
  assert.match(source, /disabled=\{inFlight \|\| !toMember\}/);
  assert.match(source, /disabled=\{inFlight\}\s*\n\s*onClick=\{\(\) => void execute\(suggestion, toMember, result\.clientRequestId\)\}/);
  // 单飞闸：execute 与 submitMembers 共用 inFlightRef，在途直接返回。
  assert.match(source, /if \(!team \|\| !body \|\| inFlightRef\.current\) return;/);
  assert.match(source, /if \(!team \|\| !MEMBER_NAME_PATTERN\.test\(addName\) \|\| inFlightRef\.current\) return;/);
  // conflict 行只有「刷新」（重取代际），没有重试投递按钮。
  const conflictBlock = source.slice(source.indexOf('result.phase === "conflict"'), source.indexOf('result.phase === "failed"'));
  assert.match(conflictBlock, /teams\.dispatch\.refresh/);
  assert.doesNotMatch(conflictBlock, /teams\.dispatch\.retry/);
  // failed 行有「重试投递」。
  const failedBlock = source.slice(source.indexOf('result.phase === "failed"'), source.indexOf("agent-teams-dispatch-confirm"));
  assert.match(failedBlock, /teams\.dispatch\.retry/);
  // skipped 落地只写 skipped 文案，整个响应处理里 skipped 不产生 failed 态。
  assert.match(source, /phase: "skipped", text: t\("teams\.dispatch\.skipped"\)/);
});

test("源码钉法：边界三件套——无定时器、workload 失败降级不抛出、outcome 不凭 ok 猜", () => {
  // 无自动轮询定时器（刷新只随快照节奏 + 手动按钮）。
  assert.doesNotMatch(source, /setInterval/);
  // GET workload 失败只 setLoadError（面板内降级），不把错误抛给画布。
  const catchBlock = source.slice(source.indexOf("} catch (error) {"), source.indexOf("} finally {"));
  assert.match(catchBlock, /setLoadError\(/);
  assert.doesNotMatch(catchBlock, /throw/);
  // 投递结果必须消费 delivery.outcome/skipped，不得凭 payload.ok 宣称已唤醒。
  assert.match(source, /delivery\?\.skipped/);
  assert.match(source, /const outcome = delivery\?\.outcome \?\? "failed";/);
});
