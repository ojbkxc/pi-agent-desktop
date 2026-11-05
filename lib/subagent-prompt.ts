export interface SubagentPromptPlan {
  chatOnly: boolean;
  appendSystemPrompt: string[];
  delegatedTask: string;
  exactSystemPrompt?: string;
}

/**
 * 团队成员身份提示（设计文档 §8.4「worker 不能再 spawn worker」）。
 *
 * 宿主在派发成员时把成员名与团队名写进 system prompt：成员明确知道自己**不是**
 * team-lead、不能创建团队或派发成员，需要更多人力时用 team_message 请求 lead。
 * 宿主未注入身份（普通 subagent / Agent 工具）时返回 undefined，保持既有行为。
 */
export function buildTeamMemberIdentityPrompt(identity?: { agentName?: string; teamName?: string }): string | undefined {
  const agentName = identity?.agentName?.trim();
  if (!agentName || agentName === 'team-lead') return undefined;
  const teamName = identity?.teamName?.trim();
  const teamLine = teamName ? `属于团队 "${teamName}"。` : '属于某个 agent 团队。';
  return [
    `你是团队成员 "${agentName}"，${teamLine}`,
    '你不是 team-lead（团队协调者）。',
    '你不能创建团队（team_create）、提交团队计划（team_plan）或删除团队（team_delete）；这些团队级操作仅限 team-lead。',
    '需要更多人力（派发新成员、拆分团队等）时，用 team_message 请求 team-lead 处理。',
  ].join('\n');
}

export function buildSubagentPromptPlan(options: {
  profileSystemPrompt: string;
  tools: readonly string[];
  loadSkills?: boolean;
  loadExtensions?: boolean;
  promptMode?: "replace" | "append";
  task: string;
  inheritedParentContext?: string;
  /** 团队成员身份（宿主注入；缺省不注入）。 */
  teamIdentity?: { agentName?: string; teamName?: string };
}): SubagentPromptPlan {
  const chatOnly = options.tools.length === 0 && !options.loadSkills && !options.loadExtensions;
  const replacePrompt = options.promptMode === "replace";
  const appendSystemPrompt = [options.profileSystemPrompt];
  const identityPrompt = buildTeamMemberIdentityPrompt(options.teamIdentity);
  if (identityPrompt) appendSystemPrompt.push(identityPrompt);
  if (options.inheritedParentContext && !chatOnly) {
    appendSystemPrompt.push(options.inheritedParentContext);
  }
  return {
    chatOnly,
    appendSystemPrompt,
    delegatedTask: options.inheritedParentContext && chatOnly
      ? `${options.task}\n\n${options.inheritedParentContext}`
      : options.task,
    ...(chatOnly || replacePrompt ? { exactSystemPrompt: options.profileSystemPrompt } : {}),
  };
}
