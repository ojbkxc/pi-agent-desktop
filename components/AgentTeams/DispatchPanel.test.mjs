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
  createRequestGate,
  pruneRowResults,
  MEMBER_NAME_PATTERN,
  ADD_MEMBER_MAX_PER_REQUEST,
  DISPATCH_MAX_CONCURRENCY,
  chunkMemberNames,
  mergeMemberReceipts,
  newClientRequestId,
  parseMemberNames,
  runWithConcurrency,
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

test("suggestionRowKey 稳定：同票同派活同代际唯一，assignmentId / expectedUpdatedAt 变则 key 变", () => {
  assert.equal(suggestionRowKey(assignSuggestion), "assign:t1::");
  assert.equal(suggestionRowKey(reassignSuggestion), "reassign:t2:assign-1:1762560000000");
  assert.notEqual(
    suggestionRowKey(reassignSuggestion),
    suggestionRowKey({ ...reassignSuggestion, assignmentId: "assign-2" }),
  );
  // 代际（expectedUpdatedAt）改变 → key 改变：旧代际的失败/冲突结果不会串到新建议行。
  assert.notEqual(
    suggestionRowKey(reassignSuggestion),
    suggestionRowKey({ ...reassignSuggestion, expectedUpdatedAt: 1762569999999 }),
  );
});

test("createRequestGate：只认最新一次 begin 的序号（并发/乱序的基础）", () => {
  const gate = createRequestGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(gate.isLatest(first), false, "旧请求不再是最新");
  assert.equal(gate.isLatest(second), true, "最新请求有效");
  const third = gate.begin();
  assert.equal(gate.isLatest(second), false);
  assert.equal(gate.isLatest(third), true);
});

test("refresh 竞态：两个 deferred fetch 先发后到——只采用最新响应", async () => {
  /**
   * 复刻组件 refresh 的竞态口径：每次请求 begin() 取序号，响应到达时只有 isLatest 才落地。
   * 两个 deferred fetch 模拟「先发的后到」：后发（new）先 resolve，先发（old）后 resolve，
   * 断言最终只采用 new。
   */
  function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }
  const gate = createRequestGate();
  const applied = [];
  const load = async (d) => {
    const id = gate.begin();
    const data = await d.promise; // 模拟 fetch(url).then(json)
    if (!gate.isLatest(id)) return; // 旧响应被丢弃
    applied.push(data);
  };

  const slow = deferred();   // 先发
  const fast = deferred();   // 后发
  const pSlow = load(slow);
  const pFast = load(fast);
  fast.resolve({ marker: "new" });  // 后发的先到
  await pFast;
  slow.resolve({ marker: "old" });  // 先发的后到
  await pSlow;

  assert.deepEqual(applied, [{ marker: "new" }], "只采用最新一次请求的响应（旧的被丢弃）");
});

test("pruneRowResults：刷新后清掉已消失 / 代际变化的行结果，同代际保留", () => {
  const reassign = { kind: "reassign", ticketId: "t2", assignmentId: "a1", expectedUpdatedAt: 100, reason: "x" };
  const key = suggestionRowKey(reassign);
  const prev = {
    [key]: { phase: "failed", text: "boom", clientRequestId: "r", body: {} },
    "delivered:gone::": { phase: "delivered", text: "ok" },
  };

  // 建议仍在但代际变了：旧 key 不在新集合 → 清掉；已消失建议也清掉。
  const afterGenChange = pruneRowResults(prev, [{ ...reassign, expectedUpdatedAt: 200 }]);
  assert.equal(afterGenChange[key], undefined, "代际变化清掉旧结果");
  assert.equal(afterGenChange["delivered:gone::"], undefined, "已消失建议清掉");

  // 同代际仍在 → 保留该行；消失的行清掉。
  const sameGen = pruneRowResults(prev, [reassign]);
  assert.equal(sameGen[key].phase, "failed", "同代际结果保留");
  assert.equal(sameGen["delivered:gone::"], undefined);

  // 无变化：返回原对象引用（避免无谓重渲染）。
  const steady = { [key]: prev[key] };
  assert.equal(pruneRowResults(steady, [reassign]), steady);
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
  // 在途闸（本轮修复：面板级单飞 → 逐行在途）：
  // 同一行在途时不再发（防重复派活），但不同行之间不再互相阻塞——
  // 旧的 `inFlightRef` 会让任一行在途时其他行的「确认/重试」静默 return，
  // 20 条建议只能一条条串着点，正是「多派成员、多并发」被 UI 按死的地方。
  assert.doesNotMatch(source, /inFlightRef/, "不得回退到面板级单飞闸");
  assert.match(source, /if \(pendingRowsRef\.current\.has\(rowKey\)\) return;/, "同一行在途不再发");
  assert.match(source, /if \(membersPendingRef\.current\) return;/, "加成员提交另有独立在途闸");
  assert.match(source, /pendingRowsRef\.current\.add\(rowKey\);/, "在途记账");
  assert.match(source, /pendingRowsRef\.current\.delete\(rowKey\);/, "落地即释放在途记账");
  // conflict 行只有「刷新」（重取代际），没有重试投递按钮。
  const conflictBlock = source.slice(source.indexOf('result.phase === "conflict"'), source.indexOf('result.phase === "failed"'));
  assert.match(conflictBlock, /teams\.dispatch\.refresh/);
  assert.doesNotMatch(conflictBlock, /teams\.dispatch\.retry/);
  // failed 行有「重试投递」（截到**该行之后**的确认区；批量确认区在列表之前，
  // 所以必须从 failed 分支的位置往后找，不能取文件里第一次出现的那个类名）。
  const failedIndex = source.indexOf('result.phase === "failed"');
  const failedBlock = source.slice(failedIndex, source.indexOf("agent-teams-dispatch-confirm", failedIndex));
  assert.match(failedBlock, /teams\.dispatch\.retry/);
  // skipped 落地只写 skipped 文案，整个响应处理里 skipped 不产生 failed 态。
  assert.match(source, /phase: "skipped", text: t\("teams\.dispatch\.skipped"\)/);
});

// interaction.md P1：派活成功（delivered/skipped/conflict）后必须收起确认区，否则
// 再点一次「确认」会以新的 clientRequestId 再 POST（后端幂等拦不住 → 成员收到两条）。
// 三个分支的分支体不可达（renderToStaticMarkup 不驱动请求），用源码哨兵钉住。
test("源码钉法：成功 / skipped / 冲突分支都收起确认区（setConfirming(null)）", () => {
  const MARK = "setConfirming((current) => (current === rowKey ? null : current))";
  const start = source.indexOf("// injected/woken/revived/buffered");
  assert.ok(start > 0, "delivered 分支存在");
  // 从「injected/woken」注释起，截到该分支结束（execute 的下一个 finally）。
  const deliveredBlock = source.slice(start, source.indexOf("} finally {", start));
  assert.ok(deliveredBlock.includes(MARK), "delivered 分支必须 setConfirming(null)");
  assert.match(deliveredBlock, /phase: "delivered"/);

  const skippedBlock = source.slice(source.indexOf("delivery?.skipped"), start);
  assert.ok(skippedBlock.includes(MARK), "skipped 分支必须 setConfirming(null)");

  const conflictStart = source.indexOf("response.status === 409");
  const conflictBlock = source.slice(conflictStart, source.indexOf("if (!response.ok || payload.error)", conflictStart));
  assert.ok(conflictBlock.includes(MARK), "409 冲突分支必须 setConfirming(null)");

  // 渲染条件本身也保证「已完成行不再渲染确认区」：!result 才显示展开按钮，确认区只在
  // confirming === rowKey 时渲染——配合上面的收起，重复派活没有入口。
  assert.match(source, /\{confirming === rowKey && !isAddMember && \(/);
  assert.match(source, /\{!result && confirming !== rowKey && \(/);
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

// T10：refresh 必须走自增请求闸（并发/乱序只认最新），成功后按建议集合修剪 rowResults。
test("源码钉法：refresh 用 createRequestGate 自增序号 + 成功刷新后 pruneRowResults", () => {
  assert.match(source, /createRequestGate/, "使用请求闸");
  assert.match(source, /const requestId = gate\.begin\(\);/, "每次 refresh 取自增序号");
  assert.match(source, /gate\.isLatest\(requestId\)/, "只接受最新响应");
  // 关键路径都过闸：成功落地、错误落地、loading 收尾。
  const refreshBlock = source.slice(source.indexOf("const refresh = useCallback"), source.indexOf("const execute = useCallback"));
  assert.ok(
    (refreshBlock.match(/gate\.isLatest\(requestId\)/g) || []).length >= 3,
    "成功 / 失败 / finally 三处都过闸",
  );
  assert.match(source, /setRowResults\(\(prev\) => pruneRowResults\(prev, data\.suggestions\)\);/,
    "成功刷新后按建议集合修剪行结果");
});

// ─────────────────────────────────────────────────────────────────────────────
// 本轮修复（并发派发 / 批量加成员 / 焦点与播报）：纯函数 + 源码哨兵。
// ─────────────────────────────────────────────────────────────────────────────

test("parseMemberNames：逗号/顿号/分号/空白/换行任意分隔，按小写去重，非法名原样回显", () => {
  const parsed = parseMemberNames("worker-one, worker-two、worker-three\nworker-four; w-5");
  assert.deepEqual(parsed.names, ["worker-one", "worker-two", "worker-three", "worker-four", "w-5"]);
  assert.deepEqual(parsed.duplicates, []);
  assert.deepEqual(parsed.invalid, []);

  // 大小写不同视为同一个名字：后端 route 按 toLowerCase 去重并静默丢弃重复项，
  // 前端不去重就会出现「提交 3 个、只回执 2 条」的错位。
  const dup = parseMemberNames("Worker-One worker-one WORKER-ONE");
  assert.deepEqual(dup.names, ["Worker-One"]);
  assert.deepEqual(dup.duplicates.slice().sort(), ["WORKER-ONE", "worker-one"]);

  const bad = parseMemberNames("中文名 ok-name ,, 9lives");
  assert.deepEqual(bad.names, ["ok-name", "9lives"]);
  assert.deepEqual(bad.invalid, ["中文名"]);
  assert.deepEqual(parseMemberNames("   ").names, []);
});

test("chunkMemberNames：按后端上限 8 切块，尾部不补齐，空输入不产生请求", () => {
  const names = Array.from({ length: 20 }, (_, index) => `w${index}`);
  const chunks = chunkMemberNames(names);
  assert.equal(ADD_MEMBER_MAX_PER_REQUEST, 8, "与 POST /members 的 1..8 硬上限一致");
  assert.deepEqual(chunks.map((chunk) => chunk.length), [8, 8, 4]);
  assert.deepEqual(chunks.flat(), names, "切块不丢不改名");
  assert.deepEqual(chunkMemberNames([]), []);
  assert.deepEqual(chunkMemberNames(["a", "b", "c"], 2), [["a", "b"], ["c"]]);
});

test("runWithConcurrency：并发不超上限、单条抛错不中断其余、失败条目如实带回", async () => {
  const items = Array.from({ length: 11 }, (_, index) => index);
  const started = [];
  let inFlight = 0;
  let peak = 0;
  const outcome = await runWithConcurrency(items, DISPATCH_MAX_CONCURRENCY, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    started.push(item);
    await new Promise((resolve) => setTimeout(resolve, 3));
    inFlight -= 1;
    if (item === 4) throw new Error("boom");
  }, { gapMs: 1 });
  assert.equal(started.length, items.length, "抛错不吞掉其余条目（Promise.all 式的整批中断必须避免）");
  assert.ok(peak <= DISPATCH_MAX_CONCURRENCY, `在途数不超过上限（实测 ${peak}）`);
  assert.deepEqual(outcome.failures.map((failure) => failure.index), [4], "失败条目按索引如实带回");

  // 起点节流：串行 3 条 → 只有后两条需要等 gap。
  const sleeps = [];
  await runWithConcurrency([1, 2, 3], 1, async () => {}, {
    gapMs: 50,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(sleeps, [50, 50]);

  // 空输入：一个请求都不发。
  let calls = 0;
  const empty = await runWithConcurrency([], 3, async () => { calls += 1; });
  assert.equal(calls, 0);
  assert.deepEqual(empty.failures, []);
});

test("newClientRequestId：randomUUID 缺失/抛错时仍有唯一 id（局域网 http 打开也能派发）", () => {
  assert.equal(newClientRequestId(() => "uuid-1"), "uuid-1");
  const fallback = newClientRequestId(() => { throw new Error("insecure context"); });
  assert.match(fallback, /^req-[0-9a-f]+-[0-9a-f]+$/);
  assert.match(newClientRequestId(() => ""), /^req-/, "空串也兜底");
  const unique = new Set(Array.from({ length: 50 }, () => newClientRequestId(() => { throw new Error("x"); })));
  assert.equal(unique.size, 50, "兜底 id 不重复（幂等 sidecar 靠它区分请求）");
});

test("mergeMemberReceipts：分块回执按名字累积，后到的块不冲掉先到的块", () => {
  const merged = mergeMemberReceipts(
    [{ name: "a", status: "spawned" }],
    [{ name: "b", status: "failed", reason: "quota" }, { name: "a", status: "failed", reason: "dup" }],
  );
  const byName = new Map(merged.map((receipt) => [receipt.name, receipt]));
  assert.equal(merged.length, 2);
  assert.equal(byName.get("a").status, "failed", "同名后者覆盖前者（最后一次尝试为准）");
  assert.equal(byName.get("b").status, "failed");
});

test("源码钉法：批量派发仍是两段式确认，确认后按并发池扇出、结果逐行落地", () => {
  assert.match(source, /data-testid="agent-teams-dispatch-batch"/);
  assert.match(source, /data-testid="agent-teams-dispatch-batch-confirm"/);
  // 批量按钮只切换确认区，绝不直接发请求（硬边界：用户显式确认后才写）。
  const batchIndex = source.indexOf('data-testid="agent-teams-dispatch-batch"');
  const batchButton = source.slice(batchIndex, source.indexOf("{batchConfirming && batchTargets.length > 0", batchIndex));
  assert.match(batchButton, /onClick=\{\(\) => setBatchConfirming/);
  assert.doesNotMatch(batchButton, /fetch\(/);
  // 扇出走同一个并发池 + 节流；每行结果仍由 executeOne 各自写 rowResults。
  assert.match(source, /await runWithConcurrency\(\s*work,\s*DISPATCH_MAX_CONCURRENCY/);
  assert.match(source, /const work = batchTargets;/);
});

test("源码钉法：批量加成员按 8 分块并发，单块失败不中断其余，回执合并显示", () => {
  assert.match(source, /const chunks = chunkMemberNames\(parsedNow\.names\);/);
  assert.match(source, /await runWithConcurrency\(chunks, ADD_MEMBER_MAX_CONCURRENCY/);
  assert.match(source, /mergeMemberReceipts\(prev \?\? \[\], results\)/, "逐块回执合并");
  // 单块异常只标该块成员为失败（不整批失败、不丢掉别的块）。
  assert.match(source, /chunk\.map\(\(name\) => \(\{ name, status: "failed", reason: message \}\)\)/);
  // 服务端没给回执的成员也要落一条失败，不能从结果区消失。
  assert.match(source, /const missing = chunk\.filter\(\(name\) => !covered\.has\(name\)\);/);
});

test("源码钉法：刷新失败保留上一份建议（本地在途/回执不被瞬时失败抹掉）", () => {
  const catchStart = source.indexOf("} catch (error) {");
  const catchBlock = source.slice(catchStart, source.indexOf("} finally {", catchStart));
  assert.match(catchBlock, /setLoadError\(/, "仍在面板内降级");
  assert.doesNotMatch(catchBlock, /setWorkload\(null\)/, "失败不再清空建议列表（否则空态文案会撒谎）");
  assert.match(catchBlock, /setLoadError\(error instanceof Error \? error\.message : String\(error\)\);/);
});

test("源码钉法：切团队清空上一队建议（防止把 A 队建议投到 B 队）", () => {
  const effectBlock = source.slice(source.indexOf("// 切团队必须清空"), source.indexOf("const refresh = useCallback"));
  assert.match(effectBlock, /\}, \[team\]\);/);
  assert.match(effectBlock, /setWorkload\(null\);/);
  assert.match(effectBlock, /setRowResults\(\{\}\);/);
  assert.match(effectBlock, /pendingRowsRef\.current\.clear\(\);/);
});

test("源码钉法：异步结果可播报可聚焦，确认区展开/收起不把焦点丢到 body", () => {
  assert.match(source, /aria-live="polite"/, "逐行结果对读屏可播报");
  assert.match(source, /role="status"/);
  assert.match(source, /tabIndex=\{-1\}/, "结果节点可被程序聚焦");
  assert.match(source, /setFocusRequest\(\{ key: rowKey, target: "confirm"/, "展开确认区 → 焦点进确认按钮");
  assert.match(source, /setFocusRequest\(\{ key: rowKey, target: "execute"/, "收起确认区 → 焦点回执行按钮");
  assert.match(source, /setFocusRequest\(\{ key: rowKey, target: "result"/, "派发落地 → 焦点到结果");
  // 内联确认区的 Esc 不得冒泡到全局「Esc 停止运行中的 agent」。
  assert.match(source, /event\.stopPropagation\(\);\s*\n\s*event\.preventDefault\(\);\s*\n\s*setBatchConfirming\(false\)/);
});
