import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

function elementBlock() {
  const start = source.indexOf("className={`chat-scroll-to-bottom");
  assert.notEqual(start, -1, "scroll-to-latest button not found");
  const buttonStart = source.lastIndexOf("<button", start);
  const buttonEnd = source.indexOf("</button>", start);
  assert.notEqual(buttonStart, -1);
  assert.notEqual(buttonEnd, -1);
  return source.slice(buttonStart, buttonEnd);
}

test("shows the scroll-to-latest button only when the viewport is detached from the tail", () => {
  assert.match(
    source,
    /className=\{`chat-scroll-to-bottom\$\{showScrollToBottom && !pendingScrollRestore \? " is-visible" : ""\}`\}/,
    "visibility must be a class toggle so the exit transition can play",
  );
});

test("floats the scroll-to-latest button above the composer, clear of the minimap", () => {
  const gate = source.indexOf("{!isEmptyNew && (");
  const marker = source.indexOf('className={`chat-scroll-to-bottom', gate);
  assert.notEqual(gate, -1);
  assert.notEqual(marker, -1);
  const container = source.slice(gate, marker);
  const block = elementBlock();

  assert.match(container, /position: "absolute"/);
  assert.match(container, /bottom: "100%"/);
  assert.match(container, /right: isMobile \? 0 : CHAT_MINIMAP_WIDTH/);
  assert.match(container, /justifyContent: "center"/);
  assert.match(container, /pointerEvents: "none"/);
  assert.match(cssSource, /\.chat-scroll-to-bottom\.is-visible \{[\s\S]*?pointer-events: auto;/);
  assert.match(cssSource, /\.chat-scroll-to-bottom:focus-visible \{[\s\S]*?outline: 2px solid var\(--accent\)/);
  assert.match(block, /onClick=\{\(\) => scrollToBottom\("smooth"\)\}/);
});

test("keeps the visible button faint until hover or focus", () => {
  const hidden = cssSource.slice(cssSource.indexOf(".chat-scroll-to-bottom {"));
  const visible = hidden.slice(hidden.indexOf(".chat-scroll-to-bottom.is-visible {"));
  const reveal = hidden.slice(hidden.indexOf(".chat-scroll-to-bottom.is-visible:hover"));

  assert.match(visible.slice(0, visible.indexOf("}")), /opacity: 0\.28;[\s\S]*?visibility: visible;[\s\S]*?transform: none;/);
  assert.match(reveal.slice(0, reveal.indexOf("}")), /opacity: 1;/);
  assert.match(
    cssSource,
    /\.chat-scroll-to-bottom\.is-visible:hover,\s*\.chat-scroll-to-bottom\.is-visible:focus-visible \{[\s\S]*?opacity: 1;/,
  );
});

test("fades the button in and out without motion when motion is reduced", () => {
  const hidden = cssSource.slice(cssSource.indexOf(".chat-scroll-to-bottom {"));

  assert.match(hidden.slice(0, hidden.indexOf("}")), /opacity: 0;[\s\S]*?visibility: hidden;[\s\S]*?transform: translateY\(4px\) scale\(0\.96\);/);
  assert.match(hidden.slice(0, hidden.indexOf("}")), /transition:[\s\S]*?opacity 0\.16s ease,[\s\S]*?transform 0\.16s ease,[\s\S]*?visibility 0s linear 0\.16s;/);
  assert.match(
    cssSource,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.chat-scroll-to-bottom,\s*\.chat-scroll-to-bottom\.is-visible \{\s*transform: none;\s*transition:\s*opacity 0\.16s ease,/,
  );
});

test("jumps to the live tail with the shared smooth scroll helper", () => {
  const block = elementBlock();

  assert.match(block, /aria-label=\{t\("chat.scrollToLatest"\)\}/);
  assert.match(source, /scrollToBottom, scrollToMessage,/);
});

test("exposes the detached-tail flag from the session hook without a ref read", () => {
  assert.match(hookSource, /const \[showScrollToBottom, setShowScrollToBottom\] = useState\(false\)/);
  assert.match(
    hookSource,
    /const shouldShow = shouldShowScrollToLatest\(scrollTop, clientHeight, scrollHeight\);\s*setShowScrollToBottom\(\(previous\) => \(previous === shouldShow \? previous : shouldShow\)\);/,
  );
  assert.match(hookSource, /promptAnchorActive,\s*showScrollToBottom,\s*\/\/ Refs/);
});

test("the scroll-save cleanup is registered once the scroll refs attach (d5-15)", () => {
  // 旧写法 deps [scrollContainerRef]（ref 对象恒定）且空引用早退：isEmptyNew 的
  // 挂载路径下两个 ref 的 DOM 不在树上，effect 早退后永不补注册，卸载保存滚位
  // 整条失效。修复后必须存在「refs 就绪」的 state 探测，且 layout effect 依赖它。
  assert.match(source, /const \[scrollRefsReady, setScrollRefsReady\] = useState\(false\);/);
  assert.match(
    source,
    /setScrollRefsReady\(Boolean\(scrollContainerRef\.current && messageContentRef\.current\)\);/,
    "a render-pass probe must re-run when the refs attach",
  );
  // layout effect 早退条件改为「未就绪」，空引用早退只留作防御；deps 必须是就绪标志。
  assert.match(source, /if \(!scrollRefsReady\) return;\s+const container = scrollContainerRef\.current;/);
  assert.match(source, /\}, \[scrollRefsReady\]\);/, "the layout effect must depend on readiness, not the constant ref object");
  assert.doesNotMatch(source, /\}, \[scrollContainerRef\]\);\s*useEffect\(\(\) => \{\s*if \(searchTarget\)/, "the old constant-deps form must be gone");
});
