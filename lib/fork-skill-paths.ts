import { additionalBuiltinSkillPaths } from "./builtin-skills";
import { additionalCcHahaSkillPaths } from "./cc-haha-skills";

/**
 * 本 fork 追加给 pi SDK 的全部「额外技能根」。
 *
 * pi SDK 默认只扫 `~/.pi/agent/skills`、`~/.agents/skills`、项目 `.pi/skills` 与项目/祖先
 * `.agents/skills`。本仓在此之外还要接两处，会话、子代理、设置 › 技能面板用的是同一份列表
 * （面板永远按「技能已启用」传 true，否则面板里看得到的技能与普通会话能用的会对不上）：
 *
 *  1. `~/.claude/skills` —— cc-haha 下载的技能（lib/cc-haha-skills.ts）。
 *  2. 随应用打包的 `builtin-skills/`（lib/builtin-skills.ts）。
 *
 * 两处都自带「目录不存在就不给」的守卫：SDK 会对不存在的技能根记一条诊断并显示在面板上。
 *
 * chat-only / 极简档（lean）**不传**本函数的任何结果 —— SDK 的 `noSkills` 不会过滤
 * `additionalSkillPaths`，只有源头不给才保持零技能（lib/cc-haha-skills.ts 的注释详述）。
 */
export function additionalForkSkillPaths(skillsEnabled: boolean): string[] {
  return [
    ...additionalCcHahaSkillPaths(skillsEnabled),
    ...additionalBuiltinSkillPaths(skillsEnabled),
  ];
}
