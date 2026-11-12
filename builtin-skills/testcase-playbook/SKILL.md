---
name: testcase-playbook
description: 测试用例生成工作手册（10 种测试设计方法 + 流程图节点覆盖矩阵 + 质量门禁 + 可复制提示词模板）。当用户要「生成测试用例」「需求文档转用例」「PRD/PDF/流程图转测试用例」「补负面用例」「评审已有用例」时使用；需求是 PDF / Word / Markdown / 截图流程图时尤其适用。
---

# 测试用例生成工作手册

把需求文档（PDF / Word / Markdown / 截图流程图）转成**可直接导入测试管理平台的测试用例**：
10 种测试设计方法系统性覆盖 + 流程图节点覆盖矩阵 + 质量门禁自检 + 可复制的 AI 提示词模板。

## 第一步：读手册正文

**先完整读取本目录下的 `测试用例生成工作手册.md`**（约 26KB），它是这套方法的唯一权威正文：
角色与总流程、需求文档形态判别、输入处理、10 种设计方法、流程图型需求专项、质量门禁、
输出格式规范（Excel 14 列 / 4 Sheet / XMind / 质量报告 / JSON）、交付约定、提示词模板、效果基准。

（本 skill 就是上游仓 [ojbkxc/testcase-playbook](https://github.com/ojbkxc/testcase-playbook) 的完整内容，
手册里的「用例表 → 平台导入格式」一节已内联在正文中，不需要额外文件。）

## 第二步（可选）：跑脚本

`scripts/` 是可选的加速件，纯聊天场景忽略即可；有本地环境时能自动校验、导出：

| 脚本 | 用途 |
|------|------|
| `scripts/extract_text.py` | Office / PDF 抽取纯文本（PDF 用 `pymupdf`，中文编码坑见手册第 2 节） |
| `scripts/flow_node_coverage.py` | 流程图节点覆盖矩阵；覆盖率不足 100% 时**非零退出**，可当门禁 |
| `scripts/generate_excel.py` | 生成 Excel（列定义 / 下拉校验 / 优先级配色） |
| `scripts/generate_xmind.py` | 生成 XMind |

依赖：`pip install pymupdf openpyxl pillow python-docx`（见 `requirements.txt`）。跑脚本时加
`PYTHONIOENCODING=utf-8`，中文输出才不乱码。脚本路径按**本 skill 目录**解析（即本 `SKILL.md` 所在目录）。

## 质量底线（不达标不许交付）

需求覆盖率 100%（通用场景 ≥ 95%）、流程图节点覆盖率 100%（有流程图时）、无孤儿用例与悬空需求 ID、
步骤条数与预期结果条数逐条配对、**负面用例占比 ≥ 30%**、优先级分布合理（P0 10-15% / P1 30-40% /
P2 35-45% / P3 10-15%）、无语义重复与需求外编造。不达标自动补齐后重检，最多 3 轮，并在质量报告里
标注未达标项与原因。

## 与内置 skill `generate-test-cases-skill` 的分工

本仓同时内置了上游项目 `generate-test-cases-skill`（同一套方法学的原始出处，含 `.memory/`
持久化记忆与按 Phase 0–5 推进的自学习闭环）。两者关系：

- **要一次性产出符合规范的用例**（尤其是流程图 / PDF 型需求、需要节点覆盖矩阵与追溯矩阵）→ 用本 skill。
- **要跨多次会话积累项目记忆、按检查点交互推进**→ 用 `generate-test-cases-skill`。
- 两者不冲突，可同时读；方法学部分重叠，按本 skill 的手册口径执行即可。

## 归属

方法学内联改编自 [RicardoDing/generate-test-cases-skill](https://github.com/RicardoDing/generate-test-cases-skill)（MIT）；
`scripts/` 下的 `extract_text.py` / `generate_excel.py` / `generate_xmind.py` 来自该项目。本项目以 MIT 发布，
详见同目录 `LICENSE` 与 `README.md`。
