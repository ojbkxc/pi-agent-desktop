/**
 * Input composer 的「Agent Team」开关背后的消息包装（对齐 cc-haha 的同名机制）。
 *
 * 打开开关后，下一条消息会在**发往模型时**前置一段固定的团队指令，而气泡里仍然只显示
 * 用户自己写的内容。指令块带自己的标签，所以重新载入的历史记录可以再把它剥掉；
 * 指令正文刻意用英文，因为它是对模型说的、不是给用户看的。
 *
 * 标签与 cc-haha 完全一致（`<agent-team-request>`），这样两边互相粘贴消息时，
 * 对方也能识别并剥离这块。
 */

const OPEN_TAG = "<agent-team-request>";
const CLOSE_TAG = "</agent-team-request>";

export const AGENT_TEAM_REQUEST_INSTRUCTION =
  "Use an Agent Team for this request: create a team, split the goal below into tasks with clear owners, "
  + "and coordinate the teammates until the goal is done.";

const REQUEST_BLOCK = new RegExp(`${OPEN_TAG}[\\s\\S]*?${CLOSE_TAG}\\n*`);

/**
 * 命令类消息不包装：`/`（扩展 / 内置斜杠命令）与 `!`（shell）必须在消息**开头**，
 * 服务端和 useAgentSession 都靠首字符判定；一旦被团队块顶开就会被当成普通提示词发给模型，
 * 扩展对话框、bash 命令都会静默失效（e2e/extension-dialog.mjs 就是这么抓到的）。
 */
export function isAgentTeamCommand(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("/") || trimmed.startsWith("!");
}

/** 把消息包成「请用 Agent Team 处理」。用户原文保持在块之后。命令类消息原样返回。 */
export function withAgentTeamRequest(content: string): string {
  if (isAgentTeamCommand(content)) return content;
  const block = `${OPEN_TAG}\n${AGENT_TEAM_REQUEST_INSTRUCTION}\n${CLOSE_TAG}`;
  return content ? `${block}\n\n${content}` : block;
}

/**
 * 气泡/历史用的正文：剥掉团队块。
 * `requested` 告诉调用方这条消息当初是否请求了团队——界面据此可以显示一个标记。
 */
export function stripAgentTeamRequest(text: string): { content: string; requested: boolean } {
  if (!text.includes(OPEN_TAG)) return { content: text, requested: false };
  const content = text.replace(REQUEST_BLOCK, "");
  return content === text ? { content: text, requested: false } : { content, requested: true };
}

/** 这条消息是否是「请求了 Agent Team」的。 */
export function hasAgentTeamRequest(text: string): boolean {
  return text.includes(OPEN_TAG);
}
