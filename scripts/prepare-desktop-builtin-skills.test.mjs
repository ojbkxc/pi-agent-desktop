import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 打包版「内置技能」的打包哨兵。
 *
 * 背景：桌面壳把服务端放进 `src-tauri/resources/server/` 后，进程 cwd 就是那里；
 * lib/builtin-skills.ts 只在 `cwd/builtin-skills`（与上一级）找内置技能根。
 * scripts/prepare-desktop.mjs 若不把 `builtin-skills/` stage 进去，打包版里两个内置 skill
 * 会**静默消失** —— dev / e2e 下 cwd 是仓库根，照样看得到，所以只有真机打包版才会暴露。
 * 这里用静态断言把它钉死，另加一条「每个内置 skill 都得是合法 skill」的内容校验。
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readText = async (path) => (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
/** 去掉整行 `//` 注释再做断言：注释里提到文件名不算数，必须是真代码。 */
const stripLineComments = (source) => source.replace(/^\s*\/\/.*$/gm, "");

const prepareDesktop = await readText(join(root, "scripts", "prepare-desktop.mjs"));
const code = stripLineComments(prepareDesktop);

test("prepare-desktop 把 builtin-skills/ 拷进 server/builtin-skills/", async () => {
  // 源目录必须真实存在且非空（否则 cp 会在打包时才炸）。
  const sourceDir = join(root, "builtin-skills");
  await access(sourceDir, constants.R_OK);
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const skillDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.ok(skillDirs.length > 0, "builtin-skills/ must contain at least one skill directory");

  // 目标：<serverResourcesDir>/builtin-skills（打包版 cwd 就是 serverResourcesDir）。
  assert.match(
    code,
    /await cp\(\s*join\(rootDir, "builtin-skills"\),\s*join\(serverResourcesDir, "builtin-skills"\),\s*\{?\s*recursive: true,?\s*\}?,?\s*\)/,
    "prepare-desktop.mjs 必须把 builtin-skills/ 拷进 resources/server/builtin-skills/",
  );
});

test("stage 的目标路径正好是运行时在打包 cwd 下查找的第一个候选", async () => {
  // 跨文件契约：builtin-skills.ts 的候选 = cwd/builtin-skills；打包版 cwd = resources/server。
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { "@": root } });
  const { builtinSkillsDirCandidates } = await jiti.import("../lib/builtin-skills.ts");

  const packagedCwd = join(root, "src-tauri", "resources", "server");
  const stagedTarget = join(packagedCwd, "builtin-skills");
  const candidates = builtinSkillsDirCandidates(packagedCwd, {});
  assert.equal(
    candidates[0],
    stagedTarget,
    "builtin-skills.ts 在打包 cwd 下的第一候选必须等于 prepare-desktop 的 stage 目标",
  );
  // 无 env 覆盖时共 2 个候选（cwd 与上一级），不应把仓库根路径混进来。
  assert.equal(candidates.length, 2);
  // prepare-desktop 的 server 资源根常量也不能漂。
  assert.match(prepareDesktop, /const serverResourcesDir = join\(rootDir, "src-tauri", "resources", "server"\)/);
});

test("每个内置 skill 目录都有带 name + description 的 SKILL.md", async () => {
  const sourceDir = join(root, "builtin-skills");
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(sourceDir, entry.name, "SKILL.md");
    await access(skillFile, constants.R_OK);
    const raw = await readText(skillFile);
    // SDK 的 loadSkills 要求 frontmatter 的 description 非空，否则整个 skill 被丢掉且只留一条诊断。
    const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(frontmatter, `${entry.name}/SKILL.md needs a --- frontmatter block`);
    assert.match(frontmatter[1], /^name:\s*\S+/m, `${entry.name}/SKILL.md needs a name`);
    assert.match(frontmatter[1], /^description:\s*\S+/m, `${entry.name}/SKILL.md needs a description`);
  }
});
