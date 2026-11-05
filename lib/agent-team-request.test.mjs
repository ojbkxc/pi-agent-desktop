/**
 * Agent Team 开关的消息包装（对齐 cc-haha 的 lib/agentTeamRequest.ts）。
 *
 * 关键契约：包装块只对模型可见 —— 落盘/发送的文本带着它，界面渲染与「编辑重发」
 * 回填时必须剥掉，否则用户会看到自己没写过的东西，或再发一次套两层。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  AGENT_TEAM_REQUEST_INSTRUCTION,
  withAgentTeamRequest,
  stripAgentTeamRequest,
  hasAgentTeamRequest,
} = await import("./agent-team-request.ts");

test("包装块前置在用户原文之前，两者都保留", () => {
  const wrapped = withAgentTeamRequest("修一下登录");
  assert.match(wrapped, /^<agent-team-request>/);
  assert.ok(wrapped.includes(AGENT_TEAM_REQUEST_INSTRUCTION));
  assert.ok(wrapped.endsWith("修一下登录"), "用户原文应在块之后");
  assert.ok(wrapped.includes("</agent-team-request>"));
});

test("空内容只剩块，不留下多余空行", () => {
  const wrapped = withAgentTeamRequest("");
  assert.doesNotMatch(wrapped, /\n\n$/, "没有原文时不该有尾随空行");
  assert.ok(wrapped.startsWith("<agent-team-request>"));
});

test("strip 能拿回用户原文，并报告这条请求过团队", () => {
  const original = "把发布清单做完";
  const { content, requested } = stripAgentTeamRequest(withAgentTeamRequest(original));
  assert.equal(content, original);
  assert.equal(requested, true);
});

test("strip 对没有块的普通文本是幂等的", () => {
  const plain = "今天天气不错";
  assert.deepEqual(stripAgentTeamRequest(plain), { content: plain, requested: false });
});

test("wrap → strip 往返稳定（多段文本）", () => {
  const original = "第一行\n\n第二段，带空行";
  const once = stripAgentTeamRequest(withAgentTeamRequest(original)).content;
  assert.equal(once, original);
  // 再包再剥仍相等（不会累积）
  const twice = stripAgentTeamRequest(withAgentTeamRequest(once)).content;
  assert.equal(twice, original);
});

test("hasAgentTeamRequest 只看标签存在与否", () => {
  assert.equal(hasAgentTeamRequest(withAgentTeamRequest("x")), true);
  assert.equal(hasAgentTeamRequest("普通消息"), false);
});

test("指令正文是英文（对模型说，不是给用户看）", () => {
  // 标签本身已锁死跨端互通，这里锁住指令语义不被误改成中文而失去与 cc-haha 的对齐。
  assert.match(AGENT_TEAM_REQUEST_INSTRUCTION, /Agent Team/);
  assert.match(AGENT_TEAM_REQUEST_INSTRUCTION, /create a team/);
  assert.doesNotMatch(AGENT_TEAM_REQUEST_INSTRUCTION, /[\u4e00-\u9fa5]/, "正文应为英文");
});
