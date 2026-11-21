# optional-skills —— 可选技能包

这里的目录**不会**被自动加载。技能面板（Settings › Skills）里点「安装」后，才会把包内
的 skill 复制到 `<agent dir>/skills/<pack>/`，下一次技能扫描才可见；点「移除」只删本包
记录过的目录。

| 目录 | 内容 | 来源 | 许可 |
|------|------|------|------|
| `redteam/` | 23 个安全测试 skill（信息收集 / 资产测绘 / 漏洞验证 / 内网横向） | [kingcharleslzy-ai/dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge) `skills/redteam/` @ `e519253d5b01344056055af9d2041dcafa42fed3`（1.7.20） | MIT（见 `redteam/LICENSE` 与 `redteam/NOTICE.md`） |

## 搬运口径

- **逐字搬运，不改内容**；唯一处理是把 CRLF 归一为 LF（`.gitattributes` 已把
  `optional-skills/**` 钉为 `eol=lf`）。
- 只搬上游仓里已提交的文件。上游的 `presets/redteam`、`skills/redteam` 之外的东西
  （宿主补丁、安装器、市场）没有带进来。
- 上游有更新时：重新 clone、覆盖 `redteam/*.md`，更新本表的 commit 与
  `lib/redteam-skills.ts` 的 `REDTEAM_PACK_COMMIT` / `REDTEAM_PACK_VERSION`，然后跑
  `node --test lib/redteam-skills.test.mjs scripts/prepare-desktop-optional-skills.test.mjs`。

## 使用边界

这些内容面向**已授权的安全测试**（自有系统、书面授权的靶标、SRC 平台在范围内的资产）。
不做任何自动执行：安装只是把文件放进技能目录，是否使用、对谁使用由操作者决定并负责。
