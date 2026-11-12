# 测试用例生成工作手册 · Test Case Generation Playbook

> 把需求文档（PDF / Word / Markdown / 截图流程图）变成**可直接导入的测试用例**：
> 10 种测试设计方法系统性覆盖 + 流程图节点覆盖矩阵 + 质量门禁自检 + 可复制的 AI 提示词模板。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#致谢与许可)
[![Docs](https://img.shields.io/badge/docs-中文-blue.svg)](./测试用例生成工作手册.md)

**适用人群**：测试工程师 / QA / 测试开发 / 任何想用 AI 写测试用例的人
**适用 AI**：Claude、ChatGPT、Gemini 及各类 agent 工具 —— 手册**完全自包含**，不依赖任何本地环境或插件

---

## 为什么需要它

| 痛点 | 本手册的解法 |
|------|-------------|
| AI 写的用例太水，只覆盖正向流程 | **强制 10 种设计方法叠加**，负面用例占比 ≥ 30%，不达标自动补齐 |
| 大型 PDF / 流程图类需求**容易漏场景** | 流程图**切块放大逐格细读** + **节点覆盖矩阵**，把"漏没漏"变成可验证的数字（目标 100%） |
| 中文 PDF 提取全是乱码 | 明确用 `pymupdf`，并给出编码坑、矢量图 / 嵌入位图的区分方法 |
| 用例写成"字段校验 / 查数据库"，不是业务测试 | **业务视角 vs 字段视角对照表** + 需求原文提示语逐字进预期结果 |
| 需求和用例对不上，改需求不知道动哪些用例 | **需求追溯矩阵**（双向）+ **「来源章节」双维度标注** |
| 每次产出风格不统一、格式各异 | 固定产物规范：Excel 14 列 / 4 Sheet / XMind 结构 / 质量报告格式 |
| 换 AI、换工具效果就变了 | 方法与细节全部内联在一份 Markdown 里，**整份发给任何 AI 即可复现** |

---

## 目录结构

```
testcase-playbook/
├── 测试用例生成工作手册.md      # ★ 主件：整份发给任意 AI 即可用（自包含）
└── scripts/                    # 可选加速件：用 Claude Code 等 agent 工具时自动跑校验
    ├── extract_text.py         # Office / PDF 抽取纯文本
    ├── flow_node_coverage.py   # 流程图节点覆盖矩阵（覆盖率不足 100% 时非零退出，可做门禁）
    ├── generate_excel.py       # 生成 Excel（列定义 / 下拉校验 / 优先级配色）
    └── generate_xmind.py       # 生成 XMind
```

---

## 三种用法

**1. 网页版 AI（最省事）**
把 `测试用例生成工作手册.md` 整份贴给 AI，再附上需求文档（或文档路径）。手册末尾有**可直接复制的提示词模板**。

**2. Agent 工具（自动校验）**
连 `scripts/` 一起给 AI，或自己跑：

```bash
pip install pymupdf openpyxl pillow python-docx
PYTHONIOENCODING=utf-8 python scripts/flow_node_coverage.py --nodes nodes.json --cases cases.json --out cov.csv
```

**3. 只想要提示词**
直接抄手册「附录 A：可直接复制的提示词模板」。

---

## 覆盖的测试设计方法

**核心 5 种（按序叠加）**：`EP` 等价类 → `BVA` 边界值 → `PV` 参数验证 → `ST` 场景法 → `EG` 错误推测
**补充 5 种（深度覆盖）**：`RV` 出参验证 · `BS` 业务状态穷举 · `RL` 关联关系 · `DB` 数据库 · `REDIS` 缓存

每种方法都给出**触发条件**与取值规则（如边界值的上点 / 离点 / 内点、开闭区间取值表），
并配套**去重规则**，避免不同方法产生语义重复的用例。

---

## 质量门禁（输出前必须全绿）

- 需求覆盖率 100%（通用场景 ≥ 95%）
- 流程图节点覆盖率 100%（有流程图时）
- 无孤儿用例、无悬空需求 ID
- 步骤条数与预期结果条数**逐条配对**
- 负面用例占比 ≥ 30%
- 优先级分布合理（P0 10-15% / P1 30-40% / P2 35-45% / P3 10-15%）
- 无语义重复、无需求外编造

不达标则自动补齐后重检，最多 3 轮，并在质量报告中标注未达标项与原因。

---

## 适用 / 不适用

| ✅ 适用 | ❌ 不适用 |
|--------|----------|
| 功能测试 / 业务逻辑测试用例设计 | 性能测试、安全渗透测试方案 |
| 从 PRD / 需求 PDF / 流程图生成用例 | 替代真实测试执行与缺陷管理 |
| 需要强制方法论覆盖与可追溯性的场景 | 希望"随便写几条"的轻量场合 |

> 本仓库只承载**方法与通用规范**，不含任何具体业务需求内容。具体业务规则以你的需求文档为准。

---

## 致谢与许可

- 方法学部分（10 种设计方法、质量指标、追溯与优先级规范）内联并改编自开源项目
  **[RicardoDing/generate-test-cases-skill](https://github.com/RicardoDing/generate-test-cases-skill)**（MIT）。
  本仓库 `scripts/` 下的 `extract_text.py` / `generate_excel.py` / `generate_xmind.py` 来自该项目，遵循其 MIT 许可。
- 流程图 / PDF 专项方法（切块细读、节点覆盖矩阵、来源章节标注）为本人实战沉淀。
- 本项目以 **MIT** 许可发布，可自由使用、修改、分发。

---

## 关键词 / Keywords

测试用例生成 · 测试用例设计 · 测试用例 · 需求文档转测试用例 · AI 测试 · LLM 生成测试用例 ·
PDF 需求解析 · 流程图测试 · 测试设计方法 · 等价类划分 · 边界值分析 · 场景法 · 错误推测 ·
节点覆盖矩阵 · 需求追溯矩阵 · 软件测试 · QA · 自动化测试 · 用例管理 · XMind · Excel · 提示词模板 ·
Prompt Engineering · Claude · ChatGPT · Gemini

test case generation · test case design · test design techniques · equivalence partitioning ·
boundary value analysis · scenario testing · error guessing · requirements traceability matrix ·
QA automation · LLM for testing · AI test case generator · prompt template · flowchart testing
