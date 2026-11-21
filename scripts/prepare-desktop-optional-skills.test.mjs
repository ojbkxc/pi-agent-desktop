import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 打包版「可选技能包」的哨兵。
 *
 * `optional-skills/` 不参与自动加载，但安装按钮要在打包版里工作，就必须被 stage 进
 * `resources/server/optional-skills/`；漏了这一步 dev 下照常能用、打包版点安装才会得到
 * 「not bundled」。这里把 stage 语句、运行时候选路径与 LF 属性一起钉住。
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readText = async (path) => (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
const stripLineComments = (source) => source.replace(/^\s*\/\/.*$/gm, "");

const prepareDesktop = await readText(join(root, "scripts", "prepare-desktop.mjs"));
const code = stripLineComments(prepareDesktop);

test("源目录存在且是合法技能包（23 个 .md + 许可文件）", async () => {
  const packDir = join(root, "optional-skills", "redteam");
  await access(packDir, constants.R_OK);
  const entries = await readdir(packDir);
  const skills = entries.filter((name) => name.endsWith(".md") && !/^(license|notice|readme)\.md$/i.test(name));
  assert.equal(skills.length, 23, "红队技能包应有 23 个 SKILL 文件");
  assert.ok(entries.includes("LICENSE"), "必须带上游 LICENSE");
  assert.ok(entries.includes("NOTICE.md"), "必须带上游 NOTICE");
});

test("prepare-desktop 把 optional-skills/ 拷进 server/optional-skills/", () => {
  assert.match(
    code,
    /await cp\(\s*join\(rootDir, "optional-skills"\),\s*join\(serverResourcesDir, "optional-skills"\),\s*\{?\s*recursive: true,?\s*\}?,?\s*\)/,
    "prepare-desktop.mjs 必须 stage optional-skills/",
  );
});

test("stage 目标与运行时在打包 cwd 下的第一候选一致", async () => {
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { "@": root } });
  const { redteamSkillsDirCandidates } = await jiti.import("../lib/redteam-skills.ts");

  const packagedCwd = join(root, "src-tauri", "resources", "server");
  assert.equal(
    redteamSkillsDirCandidates(packagedCwd, {})[0],
    join(packagedCwd, "optional-skills", "redteam"),
    "运行时第一候选必须等于 stage 目标",
  );
});

test(".gitattributes 把可选技能包钉为 LF", async () => {
  const attributes = await readText(join(root, ".gitattributes"));
  assert.match(attributes, /^optional-skills\/\*\* text eol=lf$/m);
});
