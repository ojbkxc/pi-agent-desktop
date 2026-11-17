import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import ts from "typescript";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("large source previews bypass the per-line syntax highlighter", () => {
  assert.match(source, /const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;/);
  assert.match(source, /const useLightweightSource = sourceLines\.length > SOURCE_HIGHLIGHT_MAX_LINES/);

  // Both source trees are memoized so unrelated re-renders (panel open/close,
  // selection changes) reuse them instead of rebuilding every line element.
  assert.match(source, /const highlightedSource = useMemo\(/);

  const lightweightStart = source.indexOf("const lightweightSourceLines = useMemo(");
  const lightweightEnd = source.indexOf("[sourceLines, useLightweightSource, wrapLines]", lightweightStart);
  assert.notEqual(lightweightStart, -1);
  assert.notEqual(lightweightEnd, -1);

  const lightweightSource = source.slice(lightweightStart, lightweightEnd);
  assert.match(lightweightSource, /useLightweightSource \? sourceLines\.map\(\(line, lineIndex\) =>/);
  assert.match(lightweightSource, /className="file-source-line"/);
  assert.match(lightweightSource, /className="file-source-line-content"/);
  assert.match(lightweightSource, /style=\{FILE_LINE_NUMBER_STYLE\}/);

  // The lightweight branch still wins over the syntax highlighter in the JSX.
  const branchStart = source.indexOf(") : useLightweightSource ? (");
  assert.notEqual(branchStart, -1);
  assert.match(source.slice(branchStart), /className="file-source-view is-lightweight"/);
  assert.notEqual(source.indexOf("highlightedSource", branchStart), -1);
});

test("lightweight source rows are skipped for highlighted, diff, and preview views", () => {
  // Execute the source-view calculations without mounting the file-fetching component.
  const file = ts.createSourceFile("FileViewer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const viewer = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "TextFileViewer");
  const calculations = viewer.body.statements.filter((node) =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
      ["viewerContent", "sourceLines", "language", "isHtml", "isMarkdown", "isDelimitedTable", "hasPreview", "effectiveDisplayMode", "useLightweightSource", "lightweightSourceLines"].includes(declaration.name.getText(file)),
    ),
  ).map((node) => node.getText(file)).join("\n");
  const { outputText } = ts.transpileModule(`
    return (data, displayMode, hasGitDiff = false, isDeletedDiff = false, wrapLines = false) => {
      const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;
      const FILE_LINE_NUMBER_STYLE = {};
      const isDelimitedTablePath = () => false;
      const filePath = "";
      ${calculations}
      return lightweightSourceLines;
    };
  `, { compilerOptions: { jsx: ts.JsxEmit.React } });
  const render = new Function("React", "useMemo", outputText)(React, (calculate) => calculate());
  const large = { content: "line\n".repeat(1_000), language: "text" };

  assert.equal(render({ ...large, content: "line\n".repeat(999) }, "source"), null);
  assert.equal(render(large, "diff", true), null);
  assert.equal(render(large, "source", true, true), null);
  for (const language of ["html", "markdown"]) {
    assert.equal(render({ ...large, language }, "preview"), null);
  }
  for (const mode of ["source", "diff", "preview"]) {
    const rows = render(large, mode);
    assert.equal(rows.length, 1_001, `${mode} must retain its source fallback`);
    assert.equal(rows[0].props["data-line-number"], 1);
    assert.equal(rows[0].props.children[1].props.children, "line");
  }
  assert.equal(render(large, "source", false, false, true)[0].props.children[1].props.style.whiteSpace, "pre-wrap");
});

test("markdown preview links carry PDF page fragments", () => {
  assert.match(source, /parsePdfPageFragment/);
  assert.match(source, /onOpenFile\(linkedFile, parsePdfPageFragment\(href\) \?\? undefined\)/);
});

test("every viewer's change event invalidates in-flight meta responses", () => {
  // Image, Audio, Video and Document all guard synchronize() with a request
  // tag; a change without the tag would let the older meta response overwrite
  // the size/error the change just set.
  assert.equal((source.match(/es\.addEventListener\("change", \(e\) => \{\s*syncRequestRef\.current \+= 1;/g) ?? []).length, 4);
});

test("a failed load-more keeps the loaded content; a failed first read offers retry", () => {
  // interaction.md P1：首读与增量读的 error 原先把同一份状态写进 error，渲染层只要
  // error 就整页早退 —— 一次「加载更多」的网络错误会把已读内容全部清空且无重试入口。
  assert.match(source, /const \[loadMoreError, setLoadMoreError\] = useState<\{ error: string; offset: number \} \| null>\(null\)/);
  assert.match(source, /const keepsContent = \(\) => offset > 0 \|\| dataRef\.current !== null;/);
  assert.match(source, /if \(keepsContent\(\)\) setLoadMoreError\(\{ error: d\.error, offset \}\);\s*\n\s*else setError\(d\.error\);/);
  assert.match(source, /if \(keepsContent\(\)\) setLoadMoreError\(\{ error: String\(e\), offset \}\);\s*\n\s*else setError\(String\(e\)\);/);

  // 首读失败的错误页带重试按钮，复用既有 .file-viewer-retry-button 样式。
  assert.match(source, /className="file-viewer-status is-error" role="alert"/);
  assert.match(source, /className="file-viewer-retry-button"[\s\S]*?onClick=\{\(\) => \{\s*setLoading\(true\);\s*setError\(null\);\s*void fetchContent\(filePath\)\.finally\(\(\) => setLoading\(false\)\);\s*\}\}[\s\S]*?t\("common\.retry"\)/);

  // 增量/重载失败只在内容上方内联报错，重试按失败时的 offset 续读。
  assert.match(source, /\{loadMoreError && \(\s*\n\s*<div\s*\n\s*role="alert"/);
  assert.match(source, /const \{ offset \} = loadMoreError;[\s\S]*?fetchContent\(filePath, offset\)/);
});
