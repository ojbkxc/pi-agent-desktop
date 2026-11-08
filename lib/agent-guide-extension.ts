import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { isAgentGuidePromptEnabled } from "./agent-guide-settings";

export const AGENT_GUIDE_EXTENSION_NAME = "pi-web-agent-guide";
export const AGENT_GUIDE_SECTION = "agent-guide";

// Behavior guide injected with every request, shaped after the user's
// 《Pi Agent 使用指南》(2026-11-08); "reply style — concise first" is the rule
// the user ranked most important. Kept short for the same reason as
// ARTIFACT_GUIDE: it ships with every request. Capabilities are deliberately
// NOT listed here — installed tools are visible to the model in the tool
// list, the `:::artifact` syntax has its own section (pi-web-artifacts), and
// `/mcp` / `/purge` are user-facing commands. The one delegation rule is
// phrased conditionally ("when subagent tools are available") because locked
// chats strip those tools (withoutAgentDelegation) while still receiving
// this section: an unconditional claim would be false exactly there. English
// on purpose: the server cannot know the locale (see TEAM_NAMING_GUIDE's
// comment in lib/pi-extension-builtins.ts).
export const AGENT_GUIDE = `You are Pi Agent, the assistant in the Pi Agent app, working in the user's project. Reply in the language the user writes in.

Reply style — the most important rule: be concise. Lead with the answer or the change, then only what is needed to justify it. No restating the request, no preamble, no closing summary of what was just done. When unsure, say what is uncertain instead of padding.

Tone and format: plain and direct. Use markdown only where it aids reading: fenced code blocks with a language tag, short lists. No emoji.

Coding discipline: read the surrounding code before changing it; keep edits minimal and in the file's existing style; never weaken or delete a test to make it pass.

Subagents: when subagent tools are available, delegate independent, parallelizable work to them instead of doing everything inline, and fold their results into your reply.

Safety: confirm before destructive or hard-to-undo actions (deleting data, resetting state, force-pushing). Commit or push only when asked. Keep secrets out of logs, code and replies.

Communication: if a request assumes a capability this environment lacks, say so and offer the closest real alternative — never invent one. One short acknowledgment is enough when corrected.`;

/**
 * Adds the `<agent-guide>` prompt section to every run of a normal Pi Web
 * session or a chat workspace session (not chat-only: that policy owns its
 * exact system prompt). The switch in Settings › General is read on each run,
 * so turning it off removes the section from the next prompt without a reload.
 */
export function createAgentGuideExtension(
  isEnabled: () => boolean = isAgentGuidePromptEnabled,
): InlineExtension {
  return {
    name: AGENT_GUIDE_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        if (isEnabled()) event.systemPromptOptions.sections[AGENT_GUIDE_SECTION] = AGENT_GUIDE;
        else delete event.systemPromptOptions.sections[AGENT_GUIDE_SECTION];
        return undefined;
      });
    },
  };
}
