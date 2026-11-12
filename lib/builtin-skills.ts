import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * 随应用打包的内置技能根（仓库里的 `builtin-skills/`）。
 *
 * 每个子目录是一个内置 skill（内有 `SKILL.md`），开箱即在会话里可用，用户不需要去市场下载。
 *
 * 路径必须靠 `process.cwd()` 推：打包版的服务端由 `src-tauri/src/lib.rs` 的
 * `start_packaged_server_attempt` 用 `.current_dir(resource_dir/resources/server)` 拉起，
 * 所以那里的 cwd 就是 `resources/server`，而 `scripts/prepare-desktop.mjs` 把本目录整体
 * stage 成 `resources/server/builtin-skills`；dev / e2e 下 cwd 是仓库根，同一相对路径照样命中。
 * **不能**写死绝对路径，也不能指望 Next 的文件追踪（@vercel/nft）—— 运行期拼出来的路径它
 * 看不到，这正是 prepare-desktop.mjs 要显式 cp 的原因（与 `scripts/prepare-cloudflared.mjs`
 * 那条链路同因，见 lib/public-access/install.ts 的说明）。
 */
const BUILTIN_SKILLS_DIRNAME = "builtin-skills";

/** 候选路径：显式 env 覆盖 → 服务端/仓库根 → 上一级（容错）。 */
export function builtinSkillsDirCandidates(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const override = env.PI_WEB_BUILTIN_SKILLS_DIR?.trim();
  return [
    ...(override ? [override] : []),
    join(cwd, BUILTIN_SKILLS_DIRNAME),
    join(cwd, "..", BUILTIN_SKILLS_DIRNAME),
  ];
}

/** 第一个存在的内置技能根；都没有返回 null。 */
export function builtinSkillsDir(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return builtinSkillsDirCandidates(cwd, env).find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * 内置技能根当前是否可用：目录存在才算。
 *
 * SDK 会对不存在的 `additionalSkillPaths` 记一条 "Skill path does not exist" 诊断并显示在
 * 技能面板里，所以目录不在时干脆不给，避免凭空多出一条错误（与 lib/cc-haha-skills.ts 同约定）。
 */
export function hasBuiltinSkills(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return builtinSkillsDir(cwd, env) !== null;
}

/**
 * 传给 `DefaultResourceLoader` / `createAgentSessionServices` 的 `additionalSkillPaths` 里的
 * 内置部分。
 *
 * `skillsEnabled` 由调用方按会话策略给出（chat-only / 极简档不加载技能时为 false）。**不能**
 * 指望 SDK 的 `noSkills` 拦住这份根：`dist/core/resource-loader.js` 的 `noSkills` 分支仍会把
 * `additionalSkillPaths` 并进 skillPaths，只有在源头就不传才保持零技能。
 */
export function additionalBuiltinSkillPaths(
  skillsEnabled: boolean,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!skillsEnabled) return [];
  const dir = builtinSkillsDir(cwd, env);
  return dir ? [dir] : [];
}

/**
 * 该技能文件是否来自内置根（技能面板据此把它显示成只读的「内置」技能）。
 *
 * 内置根是**应用资源目录**（macOS 的 `.app` 只读），每次升级还会被重建；技能面板的
 * `disable-model-invocation` 开关走 `PATCH /api/skills` 的 `getSkillEditRoots()`，那里并不放行
 * 资源目录 —— 所以放行写入只会得到 403 或一个升级后失效的开关，面板改为只读展示。
 */
export function isBuiltinSkillPath(
  filePath: string,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const dir = builtinSkillsDir(cwd, env);
  if (!dir) return false;
  const rel = relative(resolve(dir), resolve(filePath));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
