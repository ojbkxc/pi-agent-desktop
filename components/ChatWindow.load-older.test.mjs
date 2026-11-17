import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

// ── interaction.md P2：「加载更早消息」失败无提示、sentinel 不可点 ─────────────
test("加载更早消息失败时露出可点重试，并保留 sentinel 供观察", () => {
  // loadContext 在 useAgentSession 内吞掉失败（只 console.error），但成功时返回新一页
  // context、失败/代次失效/卸载时返回 undefined——ChatWindow 以此判定本次加载是否失败。
  assert.match(source, /if \(!context\) setOlderLoadFailed\(true\);/, "loadContext 无返回值即判定失败");
  assert.match(source, /\(\) => setOlderLoadFailed\(true\)/, "请求被拒绝时也判定失败");
  // 失败行是真正的 button，点击重新加载同一 historyCursor。
  assert.match(
    source,
    /\{olderLoadFailed && \(\s*<button\s+type="button"\s+onClick=\{loadOlderPage\}/,
    "失败时渲染可点重试按钮",
  );
  // sentinel 必须仍然挂载（它是 IntersectionObserver 的目标）；失败时只隐藏旧文案。
  assert.match(
    source,
    /<div ref=\{sentinelRef\} className="py-3 text-center text-xs text-text-muted">\s*\{olderLoadFailed \? null : t\("chat\.loadEarlier"\)\}\s*<\/div>/,
    "sentinel 保留，失败时隐藏旧文案",
  );
});

// ── a11y.md P2：第二处 role="dialog"（扩展交互面板）没有可访问名称 ─────────────
test("扩展交互面板的 dialog 有可访问名称", () => {
  const dialogs = source.match(/role="dialog"/g) ?? [];
  assert.equal(dialogs.length, 2, "ChatWindow 中恰有两处 role=dialog");
  const labelled = source.match(/role="dialog"\s+aria-label=/g) ?? [];
  assert.equal(labelled.length, dialogs.length, "每个 role=dialog 都必须有 aria-label");
});
