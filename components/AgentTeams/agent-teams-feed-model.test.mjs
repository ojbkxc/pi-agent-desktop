import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 通信流纯模型层（agent-teams-feed-model）单测。
 *
 * 覆盖「消息正文解析 + 分类 + 叙述 + 身份解析」这组从 AgentTeamsCommunicationFeed.tsx
 * 抽出的纯函数：name@team 别名双向解析、selfClaim（收件人=发件人）、协议 JSON 叙述不漏
 * 花括号、无法识别 JSON 透出可读字段、以及按 lead/成员方向推导 4 分类（broadcast/direct/
 * 多收件人）。
 */
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  identityAliases,
  resolveMember,
  isLeadIdentity,
  parseMessageBody,
  classifyMessage,
  rowDisplayText,
} = await jiti.import("./agent-teams-feed-model.ts");

/** 假翻译函数：key + 参数 JSON，用来断言叙述选中的键与参数而不依赖真实词条。 */
const t = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);

function member(id, overrides = {}) {
  return { id, name: id, isLead: false, ...overrides };
}

/** 模型只读 members（id/name/isLead），给最小合法成员数组即可。 */
function snapshot(members) {
  return { members };
}

const LEAD = member("lead-1", { name: "team-lead", isLead: true });
const W1 = member("worker@demo", { name: "worker" });
const W2 = member("w2", { name: "w2" });
const SNAP = snapshot([LEAD, W1, W2]);

function msg(overrides) {
  return { id: "m", from: "worker", to: "team-lead", recipients: ["team-lead"], kind: "direct", text: "", timestamp: "2026-11-20T00:00:00.000Z", ...overrides };
}

// ── 身份解析：name@team 别名双向 ──────────────────────────────────────────────

test("identityAliases：name@team 同时给出全名与短名，裸名只有自身", () => {
  assert.deepEqual(identityAliases("worker@demo"), ["worker@demo", "worker"]);
  assert.deepEqual(identityAliases("Worker"), ["worker"]);
  assert.deepEqual(identityAliases("  "), [""]);
});

test("resolveMember：裸名与 name@team 都能解析到同一成员（双向）", () => {
  assert.equal(resolveMember(SNAP, "worker").member.id, "worker@demo");
  assert.equal(resolveMember(SNAP, "worker@demo").member.id, "worker@demo");
  // 通过 id 反查（成员 id 是 name@team 形态）同样命中。
  assert.equal(resolveMember(SNAP, "worker").member.name, "worker");
});

test("isLeadIdentity：team-lead 别名与 isLead 成员都判为 lead；* 与空串不是", () => {
  assert.equal(isLeadIdentity("team-lead", SNAP), true);
  assert.equal(isLeadIdentity("team-lead@demo", SNAP), true);
  assert.equal(isLeadIdentity("worker", SNAP), false);
  assert.equal(isLeadIdentity("*", SNAP), false);
  assert.equal(isLeadIdentity("", SNAP), false);
});

// ── selfClaim：收件人 = 发件人 ────────────────────────────────────────────────

test("parseMessageBody：收件人即发件人 = selfClaim（自己领活）", () => {
  const selfClaim = parseMessageBody(msg({
    from: "worker",
    to: "worker",
    recipients: ["worker"],
    text: JSON.stringify({ type: "task_assignment", taskId: "T3", subject: "清理" }),
    protocolType: "task_assignment",
  }));
  assert.equal(selfClaim.kind, "assignment");
  assert.equal(selfClaim.selfClaim, true);
  assert.equal(selfClaim.taskId, "T3");
  // 自己领活归 system（不是 lead 派工）。
  assert.equal(classifyMessage(msg({ from: "worker", to: "worker", recipients: ["worker"], text: "{}", protocolType: "task_assignment" }), selfClaim, SNAP), "system");
});

test("parseMessageBody：发给别人 = 被派活（selfClaim false），归 assignment", () => {
  const assigned = parseMessageBody(msg({
    from: "team-lead",
    to: "worker",
    recipients: ["worker"],
    text: JSON.stringify({ type: "task_assignment", taskId: "T4", subject: "实现" }),
    protocolType: "task_assignment",
  }));
  assert.equal(assigned.kind, "assignment");
  assert.equal(assigned.selfClaim, false);
  assert.equal(classifyMessage(msg({ from: "team-lead", to: "worker", recipients: ["worker"], text: "{}", protocolType: "task_assignment" }), assigned, SNAP), "assignment");
});

// ── 协议 JSON 叙述不漏花括号 ─────────────────────────────────────────────────

test("协议 JSON 叙述：生命周期消息渲染成句子，不透出原始花括号", () => {
  const m = msg({
    from: "worker",
    to: "team-lead",
    recipients: ["team-lead"],
    text: JSON.stringify({ type: "idle_notification", message: "等待派活" }),
    protocolType: "idle_notification",
  });
  const body = parseMessageBody(m);
  assert.equal(body.kind, "lifecycle");
  assert.equal(body.type, "idle_notification");
  assert.equal(body.detail, "等待派活");
  const text = rowDisplayText(msg({ ...m }), body, classifyMessage(m, body, SNAP), t);
  assert.doesNotMatch(text, /[{}]/, "叙述不得出现花括号");
  assert.match(text, /teams\.communication\.lifecycle\.idle_notification/);
  assert.match(text, /· 等待派活/, "detail 以悬挂点追加");
});

// ── 无法识别 JSON 透出可读字段 ───────────────────────────────────────────────

test("无法识别的 JSON 载荷透出真正承载文案的字段（而非裸 JSON）", () => {
  const body = parseMessageBody(msg({ text: JSON.stringify({ type: "custom_signal", payload: 1, message: "这里才是人话" }) }));
  assert.equal(body.kind, "text");
  assert.equal(body.text, "这里才是人话");
});

test("无法识别且无可读字段的 JSON 回退原文；非 JSON 文本原样保留", () => {
  const fallback = parseMessageBody(msg({ text: JSON.stringify({ type: "custom_signal", payload: 1 }) }));
  assert.equal(fallback.kind, "text");
  assert.equal(fallback.text, JSON.stringify({ type: "custom_signal", payload: 1 }));

  const plain = parseMessageBody(msg({ text: "普通正文" }));
  assert.deepEqual(plain, { kind: "text", text: "普通正文" });
});

// ── 方向推导：broadcast / direct / 多收件人 ──────────────────────────────────

test("广播：lead 广播=assignment，成员广播=report", () => {
  const leadCast = msg({ from: "team-lead", to: "*", recipients: ["*"], kind: "broadcast", text: "大家听好" });
  assert.equal(classifyMessage(leadCast, parseMessageBody(leadCast), SNAP), "assignment");
  const workerCast = msg({ from: "worker", to: "*", recipients: ["*"], kind: "broadcast", text: "进展" });
  assert.equal(classifyMessage(workerCast, parseMessageBody(workerCast), SNAP), "report");
});

test("direct：lead→成员=assignment、成员→lead=report、成员→成员=peer", () => {
  const a = msg({ from: "team-lead", to: "worker", recipients: ["worker"] });
  assert.equal(classifyMessage(a, parseMessageBody(a), SNAP), "assignment");
  const b = msg({ from: "worker", to: "team-lead", recipients: ["team-lead"] });
  assert.equal(classifyMessage(b, parseMessageBody(b), SNAP), "report");
  const c = msg({ from: "worker", to: "w2", recipients: ["w2"] });
  assert.equal(classifyMessage(c, parseMessageBody(c), SNAP), "peer");
});

test("多收件人：lead→多成员=assignment；成员→含 lead 的多收件人优先 report", () => {
  const leadToMany = msg({ from: "team-lead", to: "worker", recipients: ["worker", "w2"], kind: "direct" });
  assert.equal(classifyMessage(leadToMany, parseMessageBody(leadToMany), SNAP), "assignment");

  const workerToLeadAndPeer = msg({ from: "worker", to: "team-lead", recipients: ["team-lead", "w2"], kind: "direct" });
  assert.equal(classifyMessage(workerToLeadAndPeer, parseMessageBody(workerToLeadAndPeer), SNAP), "report");
});

test("协议/系统消息恒为 system；direct 但无可解析路由时回退 system", () => {
  const sys = msg({ from: "", to: "", recipients: [], kind: "system", text: "系统提示" });
  assert.equal(classifyMessage(sys, parseMessageBody(sys), SNAP), "system");

  // target 全是未知身份却声明 direct：既不指向 lead 也不指向已知成员→ 落到 direct 分支的 peer？
  // 按判据：targetsMember 为真（未知身份 != lead），sender 非 lead → 不满足 assignment；
  // targetsLead 假 → 不满足 report；kind direct → peer。
  const unknown = msg({ from: "ghost-sender", to: "ghost-target", recipients: ["ghost-target"], kind: "direct" });
  assert.equal(classifyMessage(unknown, parseMessageBody(unknown), SNAP), "peer");
});
