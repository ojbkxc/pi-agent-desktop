import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

// cc-haha 的用户级技能根由 userHome() 解析，测试用 PI_AGENT_HOME 把它指到临时家目录。
const root = await mkdtemp(join(tmpdir(), "pi-web-cc-haha-"));
const home = join(root, "home");
const agentDir = join(root, "agent");
const previousHome = process.env.PI_AGENT_HOME;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
// The SDK's own default scan is join(getHomeDir(), ".agents", "skills") with
// getHomeDir() = process.env.HOME || homedir(); pin HOME to the temp home so the
// developer's real global skills cannot leak into these assertions.
const previousSdkHome = process.env.HOME;
process.env.PI_AGENT_HOME = home;
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { "@": process.cwd() } });
const { ccHahaSkillsDir, hasCcHahaSkills, additionalCcHahaSkillPaths } = await jiti.import("./cc-haha-skills.ts");

before(async () => {
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(home, ".claude", "skills", "alpha"), { recursive: true });
  await writeFile(
    join(home, ".claude", "skills", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: alpha skill\n---\n\n# alpha\n",
  );
});

after(async () => {
  if (previousHome === undefined) delete process.env.PI_AGENT_HOME;
  else process.env.PI_AGENT_HOME = previousHome;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousSdkHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousSdkHome;
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("the cc-haha root resolves under userHome, never a literal homedir()", async () => {
  // userHome() honours PI_AGENT_HOME, which is what defeats nft folding a literal
  // homedir() into an fs call (lib/user-home.ts). The root must track it.
  assert.equal(ccHahaSkillsDir(), join(home, ".claude", "skills"));
  const source = await readFile(new URL("./cc-haha-skills.ts", import.meta.url), "utf8");
  // No os import at all, so no literal homedir() can reach a path here (lib/user-home.ts).
  assert.doesNotMatch(source, /from ["']node:os["']|from ["']os["']/);
  assert.match(source, /return join\(userHome\(\), "\.claude", "skills"\)/);
});

test("hasCcHahaSkills reflects whether the directory exists", () => {
  assert.equal(hasCcHahaSkills(), true);
  const missing = join(root, "no-such-home");
  const saved = process.env.PI_AGENT_HOME;
  process.env.PI_AGENT_HOME = missing;
  try {
    assert.equal(hasCcHahaSkills(), false);
  } finally {
    process.env.PI_AGENT_HOME = saved;
  }
});

test("additionalCcHahaSkillPaths is empty when skills are off, even if the root exists", () => {
  // The SDK's noSkills does NOT filter additionalSkillPaths (resource-loader.js merges
  // them in the noSkills branch), so chat-only / lean must be guarded at the source.
  assert.deepEqual(additionalCcHahaSkillPaths(false), []);
  assert.deepEqual(additionalCcHahaSkillPaths(true), [ccHahaSkillsDir()]);
});

test("additionalCcHahaSkillPaths is empty when the root is absent", () => {
  const saved = process.env.PI_AGENT_HOME;
  process.env.PI_AGENT_HOME = join(root, "no-such-home");
  try {
    assert.deepEqual(additionalCcHahaSkillPaths(true), []);
  } finally {
    process.env.PI_AGENT_HOME = saved;
  }
});

test("the loader discovers a skill from the cc-haha root", async () => {
  const cwd = join(root, "cwd-discovery");
  await mkdir(cwd, { recursive: true });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalSkillPaths: additionalCcHahaSkillPaths(true),
  });
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  assert.deepEqual(skills.map((skill) => skill.name), ["alpha"]);
  assert.deepEqual(diagnostics.filter((d) => d.type === "collision"), []);
});

test("a skill reachable through a symlink alias is not counted twice", async () => {
  // ~/.agents/skills/<name> symlinks to ~/.claude/skills/<name> on this machine, so the
  // SDK already sees these skills; loading the real root too must not duplicate them.
  const cwd = join(root, "cwd-dedup");
  const aliasRoot = join(root, "alias-skills");
  await mkdir(cwd, { recursive: true });
  await mkdir(aliasRoot, { recursive: true });
  await symlink(
    join(home, ".claude", "skills", "alpha"),
    join(aliasRoot, "alpha"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalSkillPaths: [...additionalCcHahaSkillPaths(true), aliasRoot],
  });
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  assert.deepEqual(skills.map((skill) => skill.name), ["alpha"]);
  assert.deepEqual(diagnostics.filter((d) => d.type === "collision"), []);
});

test("runtime, panel and members all pass the fork's additional skill roots", async () => {
  const rpc = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const skillsService = await readFile(new URL("./skills-service.ts", import.meta.url), "utf8");
  const subagent = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");

  // Call sites go through lib/fork-skill-paths.ts, which composes the cc-haha root with the
  // bundled builtin-skills root. Asserting the shape here keeps a future edit from wiring
  // only one of the two roots into a session (lib/builtin-skills.test.mjs pins the other half).
  // Normal session and chat workspace: skills are loaded, so the roots are passed.
  assert.equal(rpc.match(/additionalSkillPaths: additionalForkSkillPaths\(true\)/g)?.length, 2);
  // A resumed member session is gated on its own snapshot's loadSkills.
  assert.match(rpc, /additionalSkillPaths: additionalForkSkillPaths\(subagentResources\.loadSkills\)/);
  // The panel lists skills the same way the runtime loads them.
  assert.match(skillsService, /additionalSkillPaths: additionalForkSkillPaths\(true\)/);
  // Team members gate on the profile's loadSkills.
  assert.match(subagent, /additionalSkillPaths: additionalForkSkillPaths\(profile\.loadSkills\)/);
  assert.match(subagent, /noSkills: !profile\.loadSkills/);
  // Nothing may bypass the combined helper and pass a single root directly.
  for (const [name, source] of [["rpc-manager.ts", rpc], ["skills-service.ts", skillsService], ["subagent-runtime.ts", subagent]]) {
    assert.doesNotMatch(source, /additionalSkillPaths: additionalCcHahaSkillPaths\(/, `${name} bypasses additionalForkSkillPaths`);
    assert.doesNotMatch(source, /additionalSkillPaths: additionalBuiltinSkillPaths\(/, `${name} bypasses additionalForkSkillPaths`);
  }
});

test("the narrowed chat-only and lean loaders carry no additional skill root", async () => {
  // noSkills is a deliberate narrowing; a root added here would bypass it.
  const chatOnly = await readFile(new URL("./chat-only.ts", import.meta.url), "utf8");
  const lean = await readFile(new URL("./lean-mode.ts", import.meta.url), "utf8");
  assert.doesNotMatch(chatOnly, /additionalSkillPaths/);
  assert.doesNotMatch(lean, /additionalSkillPaths/);
});
