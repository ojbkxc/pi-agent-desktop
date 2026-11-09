"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** 单次查找的匹配上限，与虚拟化转录的查找口径一致：超出即截断，避免卡死。 */
export const MAX_FIND_MATCHES = 1000;

/** 列表容器上标记「本列表的行从数据查找」的 DOM 属性。 */
export const FIND_TRANSCRIPT_ATTRIBUTE = "data-find-transcript";
/** 行上携带其 key 的 DOM 属性，供跳转时定位。 */
export const FIND_ROW_ATTRIBUTE = "data-find-row";

/** 一次查找命中的一行内的某处出现。 */
export interface TranscriptFindRowMatch {
  rowIndex: number;
  rowKey: string;
  /** 该行内的第几次出现（0 起）。 */
  occurrence: number;
}

/** 查找控制器：供查找条 / 测试驱动渐进挂载列表的查找。 */
export interface TranscriptFindController {
  /** 执行一次查找，返回命中总数；`preferredIndex` 指定要先跳到第几个。 */
  search(query: string, preferredIndex?: number): number;
  /** 跳到第 index 个命中。 */
  navigate(index: number): void;
  /** 清空当前查找。 */
  clear(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// 模块级单例注册表：同一时刻只有一个可见转录需要被查找。
//
// ⚠️ 本仓**没有** cc-haha 的 components/search/conversationFindBridge 与 findHighlights
// （那套是 cc-haha 的全局查找条 + DOM 高亮基础设施，本项目未移植）。这里给出一个**自包含**
// 的同款契约：注册一个控制器，由外部（未来的查找条 / 测试）驱动；行定位用 FIND_ROW_ATTRIBUTE
// + scrollIntoView，不依赖外部高亮模块。若日后移植全局查找条，把注册表对接到其 bridge 即可。
// ─────────────────────────────────────────────────────────────────────────────

let activeController: TranscriptFindController | null = null;
let lastQuery = "";

/** 注册当前可见转录的查找控制器；返回注销函数。 */
export function registerTranscriptFindController(controller: TranscriptFindController): () => void {
  activeController = controller;
  return () => {
    if (activeController === controller) activeController = null;
  };
}

/** 列表内容变化后通知：让控制器按上次的查询重跑一次（同转录变化重跑查找的语义）。 */
export function notifyTranscriptFindContentChanged(): void {
  if (activeController && lastQuery) activeController.search(lastQuery, 0);
}

/**
 * 纯函数：在行文本里逐行统计 `query` 的大小写不敏感出现次数。用于单测与控制器。
 * 命中达到 MAX_FIND_MATCHES 即停（与转录查找同口径）。
 */
export function collectRowMatches<Row>(
  rows: readonly Row[],
  rowText: (row: Row) => string,
  query: string,
): Array<{ rowIndex: number; occurrence: number }> {
  const needle = query.toLowerCase();
  const matches: Array<{ rowIndex: number; occurrence: number }> = [];
  if (!needle) return matches;
  for (let rowIndex = 0; rowIndex < rows.length && matches.length < MAX_FIND_MATCHES; rowIndex += 1) {
    const text = rowText(rows[rowIndex]!).toLowerCase();
    let occurrence = 0;
    let offset = text.indexOf(needle);
    while (offset !== -1 && matches.length < MAX_FIND_MATCHES) {
      matches.push({ rowIndex, occurrence });
      occurrence += 1;
      offset = text.indexOf(needle, offset + needle.length);
    }
  }
  return matches;
}

// 服务端渲染下 useLayoutEffect 无意义且会告警；用等价的安全别名。
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * 渐进挂载列表的查找（对齐 cc-haha 的 useTranscriptFind，含本仓限制）。
 *
 * 查找条走 DOM，因此尚未挂载的行对它不可见。本 hook 在列表显示时注册一个控制器：
 * 匹配从**数据**（`rowText`）统计，跳到某个命中时先 `revealThrough(rowIndex)` 挂载到该行，
 * 再在提交后按 FIND_ROW_ATTRIBUTE 定位并 `scrollIntoView`。
 */
export function useTranscriptFind<Row>({
  rows,
  rowKey,
  rowText,
  revealThrough,
  anchorRef,
}: {
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** 行在屏幕上的可见文本（按屏幕顺序），保证第 N 次出现就是第 N 处高亮。 */
  rowText: (row: Row) => string;
  revealThrough: (index: number) => void;
  /** 列表滚动容器内的任意元素；行定位从其作用域内查 FIND_ROW_ATTRIBUTE。 */
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const latestRef = useRef({ rows, rowKey, rowText, revealThrough });
  latestRef.current = { rows, rowKey, rowText, revealThrough };
  const matchesRef = useRef<TranscriptFindRowMatch[]>([]);
  const [active, setActive] = useState<(TranscriptFindRowMatch & { query: string }) | null>(null);

  useEffect(() => {
    const show = (match: TranscriptFindRowMatch | undefined, query: string) => {
      if (!match) {
        setActive(null);
        return;
      }
      latestRef.current.revealThrough(match.rowIndex);
      setActive({ ...match, query });
    };
    let query = "";
    const controller: TranscriptFindController = {
      search(nextQuery, preferredIndex = 0) {
        query = nextQuery;
        lastQuery = nextQuery;
        const { rows: currentRows, rowKey: keyOf, rowText: textOf } = latestRef.current;
        const matches = collectRowMatches(currentRows, textOf, nextQuery);
        matchesRef.current = matches.map((match) => ({
          ...match,
          rowKey: keyOf(currentRows[match.rowIndex]!),
        }));
        const target = matchesRef.current[Math.min(preferredIndex, matchesRef.current.length - 1)];
        show(target, nextQuery);
        return matchesRef.current.length;
      },
      navigate(index) {
        const match = matchesRef.current[index];
        if (match) show(match, query);
      },
      clear() {
        matchesRef.current = [];
        lastQuery = "";
        setActive(null);
      },
    };
    const unregister = registerTranscriptFindController(controller);
    return () => {
      unregister();
    };
  }, [anchorRef]);

  // 列表变化后重跑一次打开的查找（chat 转录同款行为）。
  const notifiedRowsRef = useRef(rows);
  useEffect(() => {
    if (notifiedRowsRef.current === rows) return;
    notifiedRowsRef.current = rows;
    notifyTranscriptFindContentChanged();
  }, [rows]);

  // 在挂载目标行的那次提交之后定位并滚动。
  useIsomorphicLayoutEffect(() => {
    if (!active) return;
    const scope = anchorRef.current;
    if (!scope) return;
    const selector = `[${FIND_ROW_ATTRIBUTE}="${active.rowKey.replace(/["\\]/g, "\\$&")}"]`;
    const element = scope.querySelector<HTMLElement>(selector);
    element?.scrollIntoView?.({ block: "center" });
  }, [active, anchorRef]);

  return { activeMatch: active };
}
