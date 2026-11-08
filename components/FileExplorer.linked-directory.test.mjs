import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { TreeNode } = await jiti.import("./FileExplorer.tsx");
const { englishMessages } = await jiti.import("@/lib/i18n/locale-plugins.ts");
const { translateMessage } = await jiti.import("@/lib/i18n/format.ts");
// d5-12/d5-18 守卫用的源码文本（CRLF 归一，供 indexOf/正则切片）。
const fileExplorerSource = (await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");
const t = (key, params) => translateMessage("en", key, { en: englishMessages }, params);

function renderNode(node, { open = true } = {}) {
  return renderToStaticMarkup(React.createElement(TreeNode, {
    node,
    depth: 0,
    cwd: "/hub",
    onOpenFile() {},
    expandedPaths: new Set(open ? [node.fullPath] : []),
    onToggleExpanded() {},
    highlightedPaths: new Set(),
    gitStatusByPath: new Map(),
    changedDirectoryPaths: new Set(),
    t,
  }));
}

const linkedNode = {
  name: "linked",
  fullPath: "/hub/linked",
  isDir: true,
  size: 0,
  children: [],
  loaded: false,
  outsideLinkTarget: "/elsewhere/project",
};

test("an expanded link that leaves the project names its target and offers to allow it", () => {
  const html = renderNode(linkedNode);
  assert.match(html, /Links to \/elsewhere\/project, outside this project/);
  assert.match(html, /<button type="button" title="Browse \/elsewhere\/project until Pi Web restarts[^"]*"[^>]*>Allow browsing<\/button>/);
  assert.doesNotMatch(html, />empty</);
});

test("a collapsed link that leaves the project is marked on its row", () => {
  const html = renderNode(linkedNode, { open: false });
  assert.match(html, /aria-label="Links to \/elsewhere\/project, outside this project"/);
  assert.doesNotMatch(html, /Allow browsing/);
});

test("ordinary directories render no link notice", () => {
  const html = renderNode({ ...linkedNode, outsideLinkTarget: undefined, loaded: true });
  assert.doesNotMatch(html, /outside this project|Allow browsing/);
  assert.match(html, />empty</);
});

test("a folder that fails to load reports why instead of staying blank", () => {
  // Before #748 the failure was swallowed and the folder opened onto nothing.
  assert.doesNotMatch(source, /catch \{\s*\/\/ ignore\s*\}/);
  assert.match(source, /setLoadError\(error instanceof Error \? error\.message : String\(error\)\)/);
  assert.match(source, /\{loadError && \(\s*<div role="alert"/);
});

test("allowing a link sends the target the operator was shown", () => {
  assert.match(source, /\?type=allow-link`, \{\s*method: "POST",\s*headers: \{ "Content-Type": "application\/json" \},\s*body: JSON\.stringify\(\{ target \}\)/);
  assert.match(source, /await allowOutsideLink\(node\.fullPath, pendingLinkTarget\);/);
  // A pending link is never listed: the server would only refuse it.
  assert.match(source, /if \(next && !loaded && !pendingLinkTarget\) loadChildren\(\);/);
});

test("a link that encloses the project or home folder warns before allowing", () => {
  const html = renderNode({ ...linkedNode, outsideLinkTarget: "/", outsideLinkEncloses: true });
  assert.match(html, /That folder contains this project or your home folder\./);
  assert.match(html, /<button type="button"[^>]*aria-live="polite"[^>]*>Allow browsing<\/button>/);
  assert.doesNotMatch(renderNode(linkedNode), /contains this project/);
  assert.doesNotMatch(source, /window\.confirm/);
  assert.match(source, /setConfirmEnclosingLink\(true\)/);
  assert.match(source, /\{confirmEnclosingLink && \(\s*<span>\{t\("files\.allowEnclosingLinkConfirm"/);
});

// ── d5-12/d5-18（frontend #46）────────────────────────────────────────────
test("d5-12：折叠目录在父级重取后对齐 props（重展开必重取，不再展示旧列表）", () => {
  const start = fileExplorerSource.indexOf("  // d5-12：父级全树重取");
  assert.ok(start !== -1, "TreeNode 的 props 对齐 effect 存在");
  const body = fileExplorerSource.slice(start, fileExplorerSource.indexOf("const loadChildren", start));
  // 条件：折叠 + 本地已加载 + 父级明确报告未加载（fetchEntries 对目录一律 loaded:false）。
  assert.match(body, /if \(!open && loaded && node\.loaded === false\) \{/);
  assert.match(body, /setChildren\(node\.children \?\? \[\]\);/);
  assert.match(body, /setLoaded\(false\);/);
});

test("d5-18：上传结果落地前比对发起时 cwd，切走则不写新项目视图", () => {
  const start = fileExplorerSource.indexOf("const applyUploadResult = useCallback((data: UploadResponse, startedCwd: string) => {");
  assert.ok(start !== -1, "applyUploadResult 必须携带发起时 cwd");
  const body = fileExplorerSource.slice(start, fileExplorerSource.indexOf("const performUpload", start));
  assert.match(body, /if \(cwdRef\.current !== startedCwd\) return;/, "cwd 已变时不得写摘要/高亮/刷新");
  assert.match(body, /joinFilePath\(startedCwd, name\)/, "高亮路径用发起时 cwd（不用渲染闭包）");
  // cwdRef 渲染期同步 + performUpload 传参。
  assert.match(fileExplorerSource, /cwdRef\.current = cwd;/);
  assert.match(fileExplorerSource, /applyUploadResult\(data, cwd\);/);
});
