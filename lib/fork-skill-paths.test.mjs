import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";

/**
 * `additionalForkSkillPaths` 的组合测试。
 *
 * 会话 / 子代理 / 面板都走这一个函数，它必须把**两个**额外技能根一起带上：
 * cc-haha 的 `~/.claude/skills` 与随应用打包的 `builtin-skills/`。
 * 漏掉任何一个，对应的一批技能就在普通会话里静默消失（面板与运行时还会对不上）。
 */

const root = await mkdtemp(join(tmpdir(), "pi-fork-skill-paths-"));
const home = join(root, "home");
const previousHome = process.env.PI_AGENT_HOME;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousOverride = process.env.PI_WEB_BUILTIN_SKILLS_DIR;
process.env.PI_AGENT_HOME = home;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

const builtinDir = join(root, "install", "builtin-skills");
process.env.PI_WEB_BUILTIN_SKILLS_DIR = builtinDir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { "@": process.cwd() } });
const { additionalForkSkillPaths } = await jiti.import("./fork-skill-paths.ts");
const { additionalCcHahaSkillPaths } = await jiti.import("./cc-haha-skills.ts");
const { additionalBuiltinSkillPaths } = await jiti.import("./builtin-skills.ts");

before(async () => {
  await mkdir(join(root, "agent"), { recursive: true });
  await mkdir(join(home, ".claude", "skills", "alpha"), { recursive: true });
  await writeFile(
    join(home, ".claude", "skills", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: alpha skill\n---\n\n# alpha\n",
  );
  await mkdir(join(builtinDir, "beta"), { recursive: true });
  await writeFile(
    join(builtinDir, "beta", "SKILL.md"),
    "---\nname: beta\ndescription: beta skill\n---\n\n# beta\n",
  );
});

after(async () => {
  for (const [key, value] of [
    ["PI_AGENT_HOME", previousHome],
    ["PI_CODING_AGENT_DIR", previousAgentDir],
    ["PI_WEB_BUILTIN_SKILLS_DIR", previousOverride],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("两个根按固定顺序合并：cc-haha 在前、内置在后", () => {
  const ccHaha = additionalCcHahaSkillPaths(true);
  assert.deepEqual(ccHaha, [join(home, ".claude", "skills")]);
  assert.deepEqual(additionalBuiltinSkillPaths(true), [builtinDir]);
  assert.deepEqual(additionalForkSkillPaths(true), [...ccHaha, ...additionalBuiltinSkillPaths(true)]);
});

test("技能未启用 → 空（两个根都不给）", () => {
  assert.deepEqual(additionalForkSkillPaths(false), []);
});

test("任何一个根缺失都不影响另一个", async () => {
  const savedBuiltin = process.env.PI_WEB_BUILTIN_SKILLS_DIR;
  const savedHome = process.env.PI_AGENT_HOME;
  try {
    // cc-haha 根不在 → 只剩内置根。
    process.env.PI_AGENT_HOME = join(root, "no-such-home");
    assert.deepEqual(additionalForkSkillPaths(true), additionalBuiltinSkillPaths(true));
    // 内置根指向一个真实但为空的新目录 → cc-haha 根仍在，内置那项换成新目录。
    const otherBuiltin = join(root, "other-install", "builtin-skills");
    await mkdir(otherBuiltin, { recursive: true });
    process.env.PI_AGENT_HOME = home;
    process.env.PI_WEB_BUILTIN_SKILLS_DIR = otherBuiltin;
    assert.deepEqual(additionalForkSkillPaths(true), [join(home, ".claude", "skills"), otherBuiltin]);
    // 注意：覆盖值**不存在**时会落到 cwd 的候选（与 lib/public-access/install.ts 的告警脚本
    // 查找同语义），所以这里不能用「指向不存在的路径」来断言「内置根缺失」。
  } finally {
    process.env.PI_WEB_BUILTIN_SKILLS_DIR = savedBuiltin;
    process.env.PI_AGENT_HOME = savedHome;
  }
});
