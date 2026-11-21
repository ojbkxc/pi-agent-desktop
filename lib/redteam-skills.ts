/**
 * 可选技能包：红队技能（`optional-skills/redteam/*.md`，来自
 * `kingcharleslzy-ai/dsh-purge` 的 `skills/redteam/`，MIT，逐字搬运）。
 *
 * **默认不加载**：这些文件不在 `builtin-skills/` 里，`additionalForkSkillPaths()`
 * 不会把它们交给 SDK。用户在技能面板点「安装」后才复制到
 * `<agent dir>/skills/redteam/<name>/SKILL.md`，下一次技能扫描才可见；「移除」只删
 * 本包记录过的目录，不会碰用户自己的技能。
 *
 * 只读边界：包目录随应用打包（`process.cwd()/optional-skills/redteam`，由
 * `scripts/prepare-desktop.mjs` stage），升级会重建；因此安装是**复制**，不是引用。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

export const REDTEAM_PACK_ID = "redteam";
/** 上游来源与版本，写进安装标记，便于面板/排障核对装的是哪一版。 */
export const REDTEAM_PACK_SOURCE = "https://github.com/kingcharleslzy-ai/dsh-purge";
export const REDTEAM_PACK_COMMIT = "e519253d5b01344056055af9d2041dcafa42fed3";
export const REDTEAM_PACK_VERSION = "1.7.20";
/** 安装标记：只有带它的 `skills/redteam/` 才允许被「移除」清空。 */
const PACK_MARKER = ".redteam-pack.json";

const PACK_ROOT_DIRNAME = "optional-skills";
const PACK_SUBDIR = "redteam";

export interface RedteamPackSkill {
  /** 文件名（不含 `.md`）；与 frontmatter `name` 一起参与校验。 */
  id: string;
  name: string;
  description: string;
  /** 原始文件内容（LF 归一后）。 */
  content: string;
}

export interface RedteamPackStatus {
  /** 本构建是否带了这个包（dev/打包都应为 true；没有目录时为 false）。 */
  bundled: boolean;
  total: number;
  installed: number;
  /** 已安装的技能名（来自安装标记，不是磁盘扫描猜测）。 */
  installedNames: string[];
}

/** 候选包目录：显式 env → 服务端/仓库根 → 上一级（与 builtin-skills 同口径）。 */
export function redteamSkillsDirCandidates(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const override = env.PI_WEB_REDTEAM_SKILLS_DIR?.trim();
  return [
    ...(override ? [override] : []),
    join(cwd, PACK_ROOT_DIRNAME, PACK_SUBDIR),
    join(cwd, "..", PACK_ROOT_DIRNAME, PACK_SUBDIR),
  ];
}

/** 第一个存在的包目录；不存在返回 null。 */
export function redteamSkillsDir(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return redteamSkillsDirCandidates(cwd, env).find((candidate) => existsSync(candidate)) ?? null;
}

/** 安装根：`<agent dir>/skills/redteam`（SDK 默认扫描的用户级技能根之下）。 */
export function redteamPackInstallRoot(agentDir: string = getAgentDir()): string {
  return join(agentDir, "skills", REDTEAM_PACK_ID);
}

/** Agent Skills 规范的 name 约束（与 SDK `validateName` 同口径）。 */
function isValidSkillName(name: string): boolean {
  return name.length > 0
    && name.length <= 64
    && /^[a-z0-9-]+$/.test(name)
    && !name.startsWith("-")
    && !name.endsWith("-")
    && !name.includes("--");
}

/** 读取包里的全部技能（按 id 排序）。没有 frontmatter `description` 的文件忽略。 */
export function readRedteamPack(packDir: string | null = redteamSkillsDir()): RedteamPackSkill[] {
  if (!packDir) return [];
  let files: string[];
  try {
    files = readdirSync(packDir);
  } catch {
    return [];
  }
  const skills: RedteamPackSkill[] = [];
  for (const file of files) {
    if (!file.toLowerCase().endsWith(".md")) continue;
    const id = file.slice(0, -".md".length);
    // LICENSE/NOTICE 之类不是技能：没有 frontmatter 的 name + description 直接跳过。
    if (id.toLowerCase() === "license" || id.toLowerCase() === "notice" || id.toLowerCase() === "readme") continue;
    const raw = readFileSync(join(packDir, file), "utf8");
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(raw);
    const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
    const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
    if (!name || !description) continue;
    skills.push({ id, name, description, content: raw.replace(/\r\n/g, "\n") });
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

/** 当前安装状态（以安装标记为准）。 */
export function redteamPackStatus(options: {
  agentDir?: string;
  packDir?: string | null;
} = {}): RedteamPackStatus {
  const packDir = options.packDir === undefined ? redteamSkillsDir() : options.packDir;
  const skills = readRedteamPack(packDir);
  const root = redteamPackInstallRoot(options.agentDir);
  const installedNames = readPackMarker(root);
  return {
    bundled: packDir !== null && skills.length > 0,
    total: skills.length,
    installed: skills.filter((skill) => installedNames.includes(skill.name)).length,
    installedNames,
  };
}

/** 安装标记里的 names；文件缺失/损坏一律当作「未安装」。 */
function readPackMarker(root: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(root, PACK_MARKER), "utf8")) as { names?: unknown };
    return Array.isArray(parsed.names)
      ? parsed.names.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * 把包安装到用户技能根。幂等：重复安装只覆盖同名 SKILL.md，并重写标记。
 * 任一技能名不合法时整体拒绝（不留半套）。
 */
export function installRedteamPack(options: {
  agentDir?: string;
  packDir?: string | null;
} = {}): { installed: number; root: string } {
  const packDir = options.packDir === undefined ? redteamSkillsDir() : options.packDir;
  const skills = readRedteamPack(packDir);
  if (!packDir || skills.length === 0) {
    throw new Error("The redteam skill pack is not bundled in this build");
  }
  const invalid = skills.filter((skill) => !isValidSkillName(skill.name));
  if (invalid.length > 0) {
    throw new Error(`Invalid skill name(s): ${invalid.map((skill) => skill.id).join(", ")}`);
  }
  if (new Set(skills.map((skill) => skill.name)).size !== skills.length) {
    throw new Error("The redteam skill pack contains duplicate skill names");
  }
  const root = redteamPackInstallRoot(options.agentDir);
  mkdirSync(root, { recursive: true });
  // A renamed/removed upstream skill must not linger: drop names from the previous
  // install that the pack no longer ships.
  const shipped = new Set(skills.map((skill) => skill.name));
  for (const previous of readPackMarker(root)) {
    if (shipped.has(previous)) continue;
    rmSync(join(root, previous), { recursive: true, force: true });
  }
  for (const skill of skills) {
    const dir = join(root, skill.name);
    mkdirSync(dir, { recursive: true });
    writePrivateFileAtomicSync(join(dir, "SKILL.md"), skill.content);
  }
  writePrivateFileAtomicSync(
    join(root, PACK_MARKER),
    `${JSON.stringify({
      version: 1,
      source: REDTEAM_PACK_SOURCE,
      upstreamVersion: REDTEAM_PACK_VERSION,
      commit: REDTEAM_PACK_COMMIT,
      names: skills.map((skill) => skill.name),
    }, null, 2)}\n`,
  );
  return { installed: skills.length, root };
}

/**
 * 移除本包。只删安装标记里记录过的子目录；没有标记就拒绝（那里可能是用户自己的
 * 技能）。用户后来加进 `skills/redteam/` 的其他目录不会被动。
 */
export function uninstallRedteamPack(options: { agentDir?: string } = {}): {
  removed: boolean;
  reason?: "not-installed" | "not-a-pack";
  names?: string[];
} {
  const root = redteamPackInstallRoot(options.agentDir);
  if (!existsSync(root)) return { removed: false, reason: "not-installed" };
  let names: string[];
  try {
    const parsed = JSON.parse(readFileSync(join(root, PACK_MARKER), "utf8")) as { names?: unknown };
    if (!Array.isArray(parsed.names)) return { removed: false, reason: "not-a-pack" };
    names = parsed.names.filter((name): name is string => typeof name === "string" && isValidSkillName(name));
  } catch {
    return { removed: false, reason: "not-a-pack" };
  }
  for (const name of names) {
    rmSync(join(root, name), { recursive: true, force: true });
  }
  rmSync(join(root, PACK_MARKER), { force: true });
  // Only take the container when nothing else was added to it.
  try {
    if (readdirSync(root).length === 0) rmdirSync(root);
  } catch {
    // Left in place is fine; it is empty.
  }
  return { removed: true, names };
}
