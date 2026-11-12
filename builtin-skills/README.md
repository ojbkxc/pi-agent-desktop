# builtin-skills —— 随应用打包的内置技能

这个目录里的每个子目录是一个**内置 skill**：随桌面版一起打包，开箱即在会话里可用，
不需要用户去市场下载或手工安装。

## 运行时怎么被加载

- `lib/builtin-skills.ts` 按 `PI_WEB_BUILTIN_SKILLS_DIR` → `process.cwd()/builtin-skills` →
  `process.cwd()/../builtin-skills` 依次找到本目录（打包版的服务端 cwd 就是
  `src-tauri/resources/server`，dev / e2e 下是仓库根 —— 两条路径都对得上）。
- 找到之后由 `lib/fork-skill-paths.ts` 与 `~/.claude/skills` 一起作为
  `additionalSkillPaths` 交给 pi SDK 的 `DefaultResourceLoader`；会话、子代理、设置 › 技能面板
  用的是同一份列表。技能未启用的会话（chat-only / 极简档）不加载。
- 目录**必须**真实存在才会被传入：SDK 对不存在的技能根会记一条 "Skill path does not exist"
  诊断并显示在面板上，所以 `hasBuiltinSkills()` 先做存在性守卫。
- `scripts/prepare-desktop.mjs` 把本目录整体 stage 进 `src-tauri/resources/server/builtin-skills`
  （见 `scripts/prepare-desktop-builtin-skills.test.mjs` 的哨兵测试）。**新增内置 skill 后不需要改
  任何打包配置**，只要目录在 `builtin-skills/` 下、内有 `SKILL.md`。

## 为什么在面板里是只读的

打包后这些文件在**应用资源目录**里（macOS 的 `.app` 只读），而且每次升级都会重建；允许在面板里
改 `disable-model-invocation` 只会得到一个 403 或一个升级后失效的开关。所以
`components/SkillsConfig.tsx` 给它们打「内置」标签、开关置灰，并把它们从分组的批量开关里排除。

## 收录内容

| 目录 | 来源 | 许可 |
|------|------|------|
| `generate-test-cases-skill/` | [RicardoDing/generate-test-cases-skill](https://github.com/RicardoDing/generate-test-cases-skill) @ `51f55e7`（逐字搬运，未改动） | 该仓库**未附 LICENSE 文件**；其方法学被下游项目标注为 MIT |
| `testcase-playbook/` | [ojbkxc/testcase-playbook](https://github.com/ojbkxc/testcase-playbook) @ `e99d842`（逐字搬运；`SKILL.md` 为本仓新增的包装文件） | MIT |

两个 skill 的方法学有重叠（playbook 的手册内联改编自 `generate-test-cases-skill`）；
`testcase-playbook/SKILL.md` 里写了各自适用的场景。**搬运文件一律不改内容**，
上游有更新就重新搬运并更新本表的 commit。

**只搬上游仓里已提交的文件**：`testcase-playbook` 本地目录里还有几个被它自己的
`.gitignore` 标为「含内部/业务信息，切勿提交」的文件（作业指导书、转格式脚本等），
**没有**带进来 —— 本仓会推到公开 GitHub。

## 更新办法

```bash
# 1. 取上游最新
git clone --depth 1 https://github.com/RicardoDing/generate-test-cases-skill.git /tmp/gts
# 2. 覆盖目录（保留本仓新增的 README / SKILL.md 包装文件）
rm -rf builtin-skills/generate-test-cases-skill
cp -r /tmp/gts builtin-skills/generate-test-cases-skill && rm -rf builtin-skills/generate-test-cases-skill/.git
# 3. 更新上表的 commit，然后跑 node --test scripts/prepare-desktop-builtin-skills.test.mjs
```

`testcase-playbook/` 同理（注意别把它的 `.git` 与 `testcase-playbook.zip` 带进来）。
