import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 可选红队技能包：清单完整性 + 安装/状态/移除的磁盘契约。
 *
 * 安装写进临时 agent dir（函数接受 agentDir 注入），不碰真实 `~/.pi`。
 */
const root = process.cwd();
const PACK_DIR = join(root, "optional-skills", "redteam");
const jiti = createJiti(import.meta.url, { alias: { "@": root }, interopDefault: true });
const lib = await jiti.import("./redteam-skills.ts");

function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "pi-redteam-skills-"));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

const VALID_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

test("包清单：23 个技能，名称唯一且符合 Agent Skills 规范", () => {
  const skills = lib.readRedteamPack(PACK_DIR);
  assert.equal(skills.length, 23, "上游 skills/redteam 共 23 个 .md");
  const names = skills.map((skill) => skill.name);
  assert.equal(new Set(names).size, names.length, "技能名唯一");
  for (const skill of skills) {
    assert.match(skill.name, VALID_NAME, `${skill.id} 的 name 必须是小写字母/数字/连字符`);
    assert.ok(skill.name.length <= 64, `${skill.id} 的 name 超长`);
    assert.ok(skill.description.length > 0, `${skill.id} 缺少 description`);
    assert.ok(!skill.content.includes("\r"), `${skill.id} 必须已归一为 LF`);
    assert.match(skill.content, /^---\r?\nname:/, `${skill.id} 保留 frontmatter`);
  }
  // LICENSE / NOTICE 不是技能。
  assert.ok(!names.includes("license") && !names.includes("notice"));
});

test("安装：23 个 SKILL.md 落到 <agent>/skills/redteam/<name>/，并写安装标记", async () => {
  await withAgentDir((agentDir) => {
    const result = lib.installRedteamPack({ agentDir, packDir: PACK_DIR });
    assert.equal(result.installed, 23);

    const installRoot = join(agentDir, "skills", "redteam");
    for (const skill of lib.readRedteamPack(PACK_DIR)) {
      const file = join(installRoot, skill.name, "SKILL.md");
      assert.ok(existsSync(file), `${skill.name} 未落盘`);
      assert.equal(readFileSync(file, "utf8"), skill.content, `${skill.name} 内容必须逐字一致`);
    }
    const marker = JSON.parse(readFileSync(join(installRoot, ".redteam-pack.json"), "utf8"));
    assert.equal(marker.names.length, 23);
    assert.match(marker.source, /dsh-purge/);
    assert.match(marker.commit, /^[0-9a-f]{40}$/);

    const status = lib.redteamPackStatus({ agentDir, packDir: PACK_DIR });
    assert.equal(status.bundled, true);
    assert.equal(status.total, 23);
    assert.equal(status.installed, 23);
  });
});

test("重复安装幂等：不产生第二份目录", async () => {
  await withAgentDir((agentDir) => {
    assert.equal(lib.installRedteamPack({ agentDir, packDir: PACK_DIR }).installed, 23);
    assert.equal(lib.installRedteamPack({ agentDir, packDir: PACK_DIR }).installed, 23);
    assert.equal(lib.redteamPackStatus({ agentDir, packDir: PACK_DIR }).installed, 23);
  });
});

test("重新安装会清掉上游已移除的旧技能名", async () => {
  await withAgentDir((agentDir) => {
    lib.installRedteamPack({ agentDir, packDir: PACK_DIR });
    const root = join(agentDir, "skills", "redteam");
    // 模拟上一版安装多出来的技能：目录 + 标记里多一个名字。
    mkdirSync(join(root, "stale-skill"), { recursive: true });
    writeFileSync(join(root, "stale-skill", "SKILL.md"), "---\nname: stale-skill\ndescription: old\n---\n");
    const markerPath = join(root, ".redteam-pack.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    marker.names.push("stale-skill");
    writeFileSync(markerPath, JSON.stringify(marker));

    lib.installRedteamPack({ agentDir, packDir: PACK_DIR });
    assert.ok(!existsSync(join(root, "stale-skill")), "新包不再提供的技能应被清掉");
    assert.equal(lib.redteamPackStatus({ agentDir, packDir: PACK_DIR }).installed, 23);
  });
});

test("移除：只删标记记录过的目录，容器一并清掉", async () => {
  await withAgentDir((agentDir) => {
    lib.installRedteamPack({ agentDir, packDir: PACK_DIR });
    const result = lib.uninstallRedteamPack({ agentDir });
    assert.equal(result.removed, true);
    assert.equal(result.names.length, 23);
    assert.ok(!existsSync(join(agentDir, "skills", "redteam")), "空容器应一起删除");
    assert.equal(lib.redteamPackStatus({ agentDir, packDir: PACK_DIR }).installed, 0);
  });
});

test("移除拒绝非本安装的目录：没有标记就原样保留用户技能", async () => {
  await withAgentDir((agentDir) => {
    const userSkill = join(agentDir, "skills", "redteam", "my-own");
    mkdirSync(userSkill, { recursive: true });
    writeFileSync(join(userSkill, "SKILL.md"), "---\nname: my-own\ndescription: mine\n---\n");

    const result = lib.uninstallRedteamPack({ agentDir });
    assert.equal(result.removed, false);
    assert.equal(result.reason, "not-a-pack");
    assert.ok(existsSync(join(userSkill, "SKILL.md")), "用户自己的技能不能被删");
  });
});

test("未安装 / 包不存在：状态如实汇报，不抛错", async () => {
  await withAgentDir((agentDir) => {
    const missing = lib.redteamPackStatus({ agentDir, packDir: null });
    assert.equal(missing.bundled, false);
    assert.equal(missing.total, 0);
    assert.equal(missing.installed, 0);

    const notInstalled = lib.redteamPackStatus({ agentDir, packDir: PACK_DIR });
    assert.equal(notInstalled.bundled, true);
    assert.equal(notInstalled.installed, 0);
  });
});
