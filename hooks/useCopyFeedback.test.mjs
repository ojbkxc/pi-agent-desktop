import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./useCopyFeedback.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("copy failures are caught and surfaced instead of becoming unhandled rejections", () => {
  // copyText 可 reject（lib/clipboard.ts）：必须同时提供成功与失败回调。
  assert.match(source, /copyText\(text\)\.then\(\s*\n\s*\(\) => \{/);
  assert.match(source, /\(\) => \{\s*\n\s*clearResetTimer\(\);\s*\n\s*setFailed\(true\);/);
});

test("the reset timer is owned: cleared before rearming and on unmount", () => {
  // state.md P2：连点两次时，第一次的复位定时器会提前清掉第二次的提示。
  assert.match(source, /const resetTimerRef = useRef<ReturnType<typeof setTimeout> \| null>\(null\)/);
  assert.match(source, /const clearResetTimer = useCallback\(\(\) => \{[\s\S]*?clearTimeout\(resetTimerRef\.current\)/);
  // 两个分支都在重新计时前清掉上一个句柄。
  assert.match(source, /clearResetTimer\(\);\s*\n\s*setCopied\(true\);/);
  assert.match(source, /clearResetTimer\(\);\s*\n\s*setFailed\(true\);/);
  // 且都在设置新定时器前完成清理。
  assert.match(source, /clearResetTimer\(\);[\s\S]{0,80}?resetTimerRef\.current = setTimeout/);
  assert.equal((source.match(/clearResetTimer\(\);/g) ?? []).length >= 2, true);
  // 卸载清理，避免对已卸载组件 setState。
  assert.match(source, /useEffect\(\(\) => clearResetTimer, \[clearResetTimer\]\)/);
});

test("the hook exposes copied / failed / copy and never rejects", () => {
  assert.match(source, /export interface CopyFeedback/);
  assert.match(source, /copy: \(text: string\) => Promise<void>/);
  assert.match(source, /return \{ copied, failed, copy \};/);
});
