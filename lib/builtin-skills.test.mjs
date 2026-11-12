import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

/**
 * 内置技能根（随应用打包的 `builtin-skills/`）的解析测试。
 *
 * 这条路径靠 `process.cwd()` 推：打包版的服务端 cwd 是 `resources/server`（Tauri 用
 * `.current_dir(resource_dir/resources/server)` 拉起），`scripts/prepare-desktop.mjs` 把
 * `builtin-skills/` 整体 stage 成 `resources/server/builtin-skills`；dev / e2e 下 cwd 是仓库根。
 * 写死绝对路径或依赖 Next 的文件追踪都会在打包版失效 —— 所以这里把「候选顺序」和
 * 「目录不存在就不给」两条钉死。
 */

const root = await mkdtemp(join(tmpdir(), "pi-builtin-skills-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
// The SDK also scans its own defaults (`<HOME>/.agents/skills`), resolved through
// getHomeDir() = process.env.HOME || homedir(). Pin HOME to the temp root so the
// developer's real global skills cannot leak into the discovery assertion.
const previousSdkHome = process.env.HOME;
process.env.HOME = join(root, "home");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { "@": process.cwd() } });
const {
  builtinSkillsDirCandidates,
  builtinSkillsDir,
  hasBuiltinSkills,
  additionalBuiltinSkillPaths,
  isBuiltinSkillPath,
} = await jiti.import("./builtin-skills.ts");

/** A fake install root: `<dir>/builtin-skills/<name>/SKILL.md`. */
const fakeRoot = join(root, "install");
const fakeSkills = join(fakeRoot, "builtin-skills");

before(async () => {
  await mkdir(join(root, "agent"), { recursive: true });
  await mkdir(join(fakeSkills, "demo-skill"), { recursive: true });
  await writeFile(
    join(fakeSkills, "demo-skill", "SKILL.md"),
    "---\nname: demo-skill\ndescription: a demo builtin skill\n---\n\n# demo\n",
  );
});

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousSdkHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousSdkHome;
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("候选顺序：env 覆盖 → cwd → cwd 上一级", () => {
  assert.deepEqual(builtinSkillsDirCandidates("/srv/server", {}), [
    join("/srv/server", "builtin-skills"),
    join("/srv/server", "..", "builtin-skills"),
  ]);
  assert.deepEqual(builtinSkillsDirCandidates("/srv/server", { PI_WEB_BUILTIN_SKILLS_DIR: "/opt/skills" }), [
    "/opt/skills",
    join("/srv/server", "builtin-skills"),
    join("/srv/server", "..", "builtin-skills"),
  ]);
});

test("命中 cwd 自己的 builtin-skills/；cwd 深一层时靠上一级兜底", () => {
  // cwd = <install>/nested → <install>/nested/builtin-skills 不在，上一级 <install>/builtin-skills 在。
  const nested = join(fakeRoot, "nested");
  assert.equal(builtinSkillsDir(nested, {}), join(fakeRoot, "builtin-skills"));
  assert.equal(hasBuiltinSkills(nested, {}), true);
  // env 覆盖优先于两个 cwd 候选。
  assert.equal(builtinSkillsDir(nested, { PI_WEB_BUILTIN_SKILLS_DIR: fakeSkills }), fakeSkills);
  // cwd 命中自己的候选时不需要兜底。
  assert.equal(builtinSkillsDir(fakeRoot, {}), fakeSkills);
});

test("目录都不在时返回 null / 空数组（不传不存在的根，避免 SDK 记诊断）", () => {
  const nowhere = join(root, "no-such-install");
  assert.equal(builtinSkillsDir(nowhere, {}), null);
  assert.equal(hasBuiltinSkills(nowhere, {}), false);
  assert.deepEqual(additionalBuiltinSkillPaths(true, nowhere, {}), []);
});

test("技能未启用时永远不传（noSkills 拦不住 additionalSkillPaths）", () => {
  // SDK 的 noSkills 分支仍会 merge additionalSkillPaths，chat-only / 极简档必须在源头就不给。
  assert.deepEqual(additionalBuiltinSkillPaths(false, fakeRoot, {}), []);
  assert.deepEqual(additionalBuiltinSkillPaths(true, fakeRoot, {}), [fakeSkills]);
});

test("isBuiltinSkillPath 只认内置根里的文件", () => {
  const inside = join(fakeSkills, "demo-skill", "SKILL.md");
  assert.equal(isBuiltinSkillPath(inside, fakeRoot, {}), true);
  // 根目录自身不算（面板只标记技能文件）。
  assert.equal(isBuiltinSkillPath(fakeSkills, fakeRoot, {}), false);
  // 相邻目录不算。
  assert.equal(isBuiltinSkillPath(join(fakeRoot, "builtin-skills-other", "SKILL.md"), fakeRoot, {}), false);
  assert.equal(isBuiltinSkillPath(join(root, "user", "skills", "SKILL.md"), fakeRoot, {}), false);
  // 根不存在时一律 false。
  assert.equal(isBuiltinSkillPath(inside, join(root, "no-such-install"), {}), false);
});

test("SDK 能从内置根发现技能（根目录里放 skill 子目录）", async () => {
  const cwd = join(root, "cwd-discovery");
  await mkdir(cwd, { recursive: true });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(root, "agent"),
    additionalSkillPaths: additionalBuiltinSkillPaths(true, fakeRoot, {}),
  });
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  assert.deepEqual(skills.map((skill) => skill.name), ["demo-skill"]);
  assert.deepEqual(diagnostics.filter((d) => d.type === "collision"), []);
});

test("仓库里真的存在两个内置 skill，且都有 name + description", async () => {
  // 真实仓库根：cwd 就是仓库根（单测从仓库根跑），所以内置根必须命中。
  const dir = builtinSkillsDir();
  assert.ok(dir, "repo builtin-skills/ must resolve from the repo root");
  const expected = ["generate-test-cases-skill", "testcase-playbook"];
  for (const name of expected) {
    const skillFile = join(dir, name, "SKILL.md");
    const raw = await readFile(skillFile, "utf8");
    assert.match(raw, /^---\r?\n[\s\S]*?name:\s*\S+/m, `${name}: SKILL.md needs a frontmatter name`);
    assert.match(raw, /^---\r?\n[\s\S]*?description:\s*\S+/m, `${name}: SKILL.md needs a frontmatter description`);
  }
});
