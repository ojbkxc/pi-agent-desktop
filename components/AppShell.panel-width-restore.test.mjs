import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// state.md P1 的 AppShell 侧：打开右侧面板会把侧栏上限压小，关闭时上限恢复。
// 两个方向都必须重钳——旧实现 `if (!rightPanelOpen) return;` 只在打开时重钳，
// 关闭后被压窄的侧栏就永远停在窄宽度（「关面板不回弹」）。
//
// 无 DOM 渲染器，所以这里只钉接线形状；「重钳只改显示宽度、不写 localStorage、
// 上限恢复后回到用户原值」由 hooks/useResizablePanel.test.mjs 的纯函数行为测试覆盖。
const source = (await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("右侧面板关闭时也重钳侧栏/右面板/文件树宽度", () => {
  const start = source.indexOf("  useEffect(() => {\n    reclampSidebarWidth();");
  assert.notEqual(start, -1, "找不到面板宽度重钳 effect");
  const effect = source.slice(start, source.indexOf("]);", start));
  assert.doesNotMatch(effect, /if \(!rightPanelOpen\) return;/, "关闭面板时不得跳过重钳");
  assert.match(effect, /reclampSidebarWidth\(\);/);
  assert.match(effect, /reclampRightPanelWidth\(\);/);
  assert.match(effect, /reclampFileTreeWidth\(\);/);
  // 关闭同样会改变上限，所以 rightPanelOpen 必须留在依赖里。
  assert.match(
    effect,
    /\[reclampFileTreeWidth, reclampRightPanelWidth, reclampSidebarWidth, rightPanelOpen, rightPanelWidth/,
  );
});