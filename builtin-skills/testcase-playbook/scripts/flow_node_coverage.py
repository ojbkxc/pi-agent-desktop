# -*- coding: utf-8 -*-
"""流程图节点覆盖矩阵计算（通用）。

把「流程图每个节点/判断分支」与「已有测试用例文本」做关键词正则匹配，
输出节点覆盖率与未覆盖清单，用于把"漏没漏场景"变成可验证的数字。

用法（Windows 下务必带 PYTHONIOENCODING=utf-8，否则中文打印报 GBK 错）：
    PYTHONIOENCODING=utf-8 python flow_node_coverage.py \
        --nodes nodes.json --cases cases.json [--out coverage.csv]

nodes.json 格式：
{
  "流程图名": [
    {"节点": "现货=N→缺货齐发", "含义": "缺货齐发判定", "关键词": ["缺货齐发", "Partial|Full"]}
  ]
}

cases.json 格式：用例数组，元素含
    用例编号 / 用例标题 / 前置条件 / 测试步骤 / 预期结果
（字段缺失按空串处理；测试步骤若为数组会先拼成字符串）
"""
import argparse
import csv
import json
import re
import sys

CASE_ID_KEYS = ('用例编号', 'id', 'ID')
TEXT_KEYS = ('用例标题', '前置条件', '测试步骤', '预期结果')


def _as_text(value):
    if value is None:
        return ''
    if isinstance(value, (list, tuple)):
        return ' '.join(_as_text(v) for v in value)
    if isinstance(value, dict):
        return ' '.join(_as_text(v) for v in value.values())
    return str(value)


def case_text(case):
    return ' '.join(_as_text(case.get(k)) for k in TEXT_KEYS)


def case_id(case, fallback):
    for k in CASE_ID_KEYS:
        v = case.get(k)
        if v:
            return str(v)
    return fallback


def load_nodes(path):
    """接受两种 nodes.json 写法：
    1) {"流程图名": [{"节点","含义","关键词"}, ...]}
    2) {"流程图名": [["节点", "含义", "kw1|kw2"], ...]}
    """
    raw = json.load(open(path, encoding='utf-8'))
    flows = {}
    for flow_name, items in raw.items():
        nodes = []
        for it in items:
            if isinstance(it, dict):
                nodes.append({
                    '节点': it.get('节点', ''),
                    '含义': it.get('含义', ''),
                    '关键词': it.get('关键词') or [],
                })
            else:
                node, meaning = it[0], it[1]
                kws = it[2] if len(it) > 2 else []
                if isinstance(kws, str):
                    kws = [kws]
                nodes.append({'节点': node, '含义': meaning, '关键词': kws})
        flows[flow_name] = nodes
    return flows


def match_keywords(node, default_kw):
    """关键词取第一个非空项；都没有则回退为节点名本身。"""
    kws = [k for k in (node.get('关键词') or []) if k]
    if not kws:
        kws = [k for k in (default_kw or []) if k]
    if not kws:
        kws = [re.escape(node['节点'])]
    return '|'.join(kws)


def main():
    ap = argparse.ArgumentParser(description='流程图节点覆盖矩阵计算')
    ap.add_argument('--nodes', required=True, help='节点清单 JSON')
    ap.add_argument('--cases', required=True, help='用例 JSON 数组')
    ap.add_argument('--out', help='可选：导出 CSV 路径')
    args = ap.parse_args()

    flows = load_nodes(args.nodes)
    cases = json.load(open(args.cases, encoding='utf-8'))
    if isinstance(cases, dict):
        cases = cases.get('cases') or cases.get('用例') or []
    texts = [(case_id(c, f'#{i + 1}'), case_text(c)) for i, c in enumerate(cases)]

    rows, total, covered, uncovered = [], 0, 0, []
    for flow_name, nodes in flows.items():
        for node in nodes:
            pattern = match_keywords(node, None)
            hits = [cid for cid, text in texts if re.search(pattern, text, re.I)]
            total += 1
            if hits:
                covered += 1
            else:
                uncovered.append(f'{flow_name} / {node["节点"]}')
            rows.append({
                '流程图': flow_name,
                '节点/判断分支': node['节点'],
                '业务含义': node.get('含义', ''),
                '匹配正则': pattern,
                '覆盖用例': ', '.join(hits) if hits else '—',
                '覆盖状态': '已覆盖' if hits else '未覆盖',
            })

    for r in rows:
        mark = 'OK ' if r['覆盖状态'] == '已覆盖' else 'NG '
        print(f'{mark}[{r["覆盖状态"]}] {r["流程图"]} / {r["节点/判断分支"]}'
              f' -> {r["覆盖用例"][:80]}')

    rate = (covered * 100.0 / total) if total else 0.0
    print()
    print(f'节点总数 {total} | 已覆盖 {covered} | 未覆盖 {total - covered} | 覆盖率 {rate:.1f}%')
    if uncovered:
        print('未覆盖节点（需补写用例）：')
        for u in uncovered:
            print(f'  - {u}')

    if args.out:
        with open(args.out, 'w', encoding='utf-8-sig', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else [])
            w.writeheader()
            w.writerows(rows)
        print(f'已导出 CSV: {args.out}')

    # 覆盖率未达 100% 时以非零退出码结束，便于脚本化门禁
    return 0 if uncovered == [] else 1


if __name__ == '__main__':
    sys.exit(main())
