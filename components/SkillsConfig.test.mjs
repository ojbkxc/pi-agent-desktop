import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// SkillsConfig 的加载竞态（d5-23）与 d5-22（FallbackSettings deps）都发生在
// 「分区保持挂载、多路并发触发加载」的场景，组件主体没有可单测的导出纯函数
// （loadSkills 是 useCallback 闭包），所以这里用源码哨兵钉住挡写点——断言被
// 放宽即意味着竞态回归。
const skillsSource = await readFile(new URL("./SkillsConfig.tsx", import.meta.url), "utf8");

test("loadSkills writes through a generation guard, stale responses cannot win (d5-23)", () => {
  // 每次调用领一个号；成功、失败、finally 三处都必须比对代际。
  assert.match(skillsSource, /const generation = \+\+loadSkillsSeqRef\.current;/);
  assert.match(
    skillsSource,
    /if \(generation !== loadSkillsSeqRef\.current\) return \[\];\s+const list = d\.skills/,
    "a stale success must not write the list",
  );
  assert.match(
    skillsSource,
    /if \(generation !== loadSkillsSeqRef\.current\) return \[\];\s+setError/,
    "a stale failure must not write the error state",
  );
  assert.match(
    skillsSource,
    /if \(generation === loadSkillsSeqRef\.current\) setLoading\(false\);/,
    "a stale finally must not clear the newer load's loading flag",
  );
});

test("all three load triggers stay wired (d5-23)", () => {
  // cwd effect / trustKey effect / 安装回讲 —— 守卫不许把触发点顺手删掉。
  assert.match(skillsSource, /void loadSkills\(\);\s*\}, \[cwd\]/);
  assert.match(skillsSource, /loadedTrustKeyRef\.current === trustKey/);
  assert.match(skillsSource, /onInstalled=\{\(\) => \{\s*void loadSkills\(\);\s*\}\}/);
});

test("bundled skills stay read-only and out of the bulk switches", () => {
  // 内置技能（skill.builtin）在应用资源目录里，写入会被 /api/skills 的
  // getSkillEditRoots() 拒（403），macOS 上还只读、升级后重建。面板必须：
  //   1. 自成一类（不能落进「路径」组后被误认为可编辑的 path 技能）；
  //   2. 开关置灰；
  //   3. 不进分组批量开关的 targets / 计数 —— 否则一次「全部停用」会刷一堆 403。
  assert.match(skillsSource, /if \(skill\.builtin\) return "builtin";/);
  assert.match(skillsSource, /matches: \(skill: Skill\) => sourceLabel\(skill\) === "builtin"/);
  assert.match(skillsSource, /disabled=\{Boolean\(skill\.builtin\)\}/);
  assert.match(skillsSource, /const toggleable = grpSkills\.filter\(\(skill\) => !skill\.builtin\);/);
  assert.match(skillsSource, /total=\{toggleable\.length\}/);
  assert.match(skillsSource, /onChange=\{\(enabled\) => void setGroupSkills\(grpLabel, toggleable, enabled\)\}/);
  // 批量开关只对可改的技能渲染。
  assert.match(skillsSource, /toggleable\.length > 0 \? \(\s*<ConfigSidebarGroupSwitch/);
});
