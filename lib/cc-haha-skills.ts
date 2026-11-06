import { existsSync } from "node:fs";
import { join } from "node:path";
import { userHome } from "./user-home";

/**
 * cc-haha 用户级技能根：cc-haha（Claude Code 系前端）把下载的技能放进
 * `~/.claude/skills`，与 pi 的 SDK 默认扫描的目录不同。
 *
 * pi 的 SDK（`@earendil-works/pi-coding-agent` 的 `DefaultResourceLoader`）默认只扫
 * `~/.pi/agent/skills`、`~/.agents/skills`、项目 `.pi/skills` 与项目/祖先目录的
 * `.agents/skills`（见 `dist/core/package-manager.js` 的默认路径列表），读不到
 * `~/.claude/skills`。把该目录作为 `additionalSkillPaths` 传进去，cc-haha 新下载的技能
 * 才会开箱出现在 pi-agent-desktop —— 不必再依赖别人手工在该目录与 `~/.agents/skills`
 * 之间建软链。
 *
 * 必须走 `userHome()`：字面量 `homedir()` 会被 @vercel/nft 在构建期折叠成对家目录的
 * glob，Windows runner 上因用户资料夹里的回调 junction 返回 EPERM 而使 webpack 构建
 * 直接失败（详见 lib/user-home.ts 的说明与 .github/workflows/windows-build-debug.yml）。
 */
export function ccHahaSkillsDir(): string {
  return join(userHome(), ".claude", "skills");
}

/**
 * 该技能根当前是否可用：目录存在才算。
 *
 * SDK 会对不存在的 `additionalSkillPaths` 记一条 "Skill path does not exist" 诊断，
 * 并原样显示在技能面板里；所以目录不在时干脆不给，避免凭空多出一条错误。
 */
export function hasCcHahaSkills(): boolean {
  try {
    return existsSync(ccHahaSkillsDir());
  } catch {
    return false;
  }
}

/**
 * 传给 `DefaultResourceLoader` / `createAgentSessionServices` 的 `additionalSkillPaths`。
 *
 * `skillsEnabled` 由调用方按会话策略给出（该会话不加载技能时为 false）。**不能**指望
 * SDK 的 `noSkills` 拦住这份额外根：`dist/core/resource-loader.js` 里 `noSkills` 分支
 * 仍会把 `additionalSkillPaths` 并进 skillPaths
 * （`this.noSkills ? mergePaths(cliEnabledSkills, this.additionalSkillPaths) : …`），
 * 只有在源头就不传，chat-only / 极简档（lean）才保持现状的零技能。
 *
 * 另：本根是**用户级全局目录**，与 `~/.agents/skills` 同性质，始终可信，不参与
 * `lib/project-trust.ts` 的项目信任判定 —— 那里只认「项目内 / 祖先目录」的
 * `./.agents/skills`（并显式排除用户自己的 `~/.agents/skills`），从不把用户级全局根
 * 当作需要信任的项目资源。所以接入本根**不需要、也不应该**改动 project-trust.ts。
 */
export function additionalCcHahaSkillPaths(skillsEnabled: boolean): string[] {
  if (!skillsEnabled) return [];
  return hasCcHahaSkills() ? [ccHahaSkillsDir()] : [];
}
