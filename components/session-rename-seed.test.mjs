import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 重命名输入框必须**预填当前显示的那个标题**。
 *
 * 报的现象（用户原话）：「我希望输入框里先有之前的名称，然后我在上面改，我现在不管在
 * 顶部重命名还是在会话上重命名都直接是空的」。
 *
 * 根因：两处入口都用 `session.name ?? ""` / `storedName` 预填。而「从未重命名过」的会话
 * `name` 就是空字符串——显示标题其实是「首条消息」的折叠结果。于是输入框开出来是空白，
 * 用户得从零敲一遍。
 *
 * 这条用源级断言钉住：预填值必须是显示标题（`title`），并且「没改名就提交」仍然不写盘
 * ——否则一次误点会把 fallback（首条消息）固化成正式名。
 */
const sidebar = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const strip = readFileSync(new URL("./AgentTeams/SessionTitleStrip.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the sidebar rename seeds from the displayed title, not from name alone", () => {
  const start = sidebar.slice(sidebar.indexOf("const startRename = useCallback"), sidebar.indexOf("const beginDeleteConfirmation"));
  assert.match(start, /setRenameValue\(title\)/, "seed with the displayed title");
  assert.doesNotMatch(start, /setRenameValue\(session\.name \?\? ""\)/, "the empty-when-unnamed seed must be gone");
});

test("the titled strip seeds from the displayed title too", () => {
  const start = strip.slice(strip.indexOf("const startEdit = useCallback"), strip.indexOf("const cancelEdit"));
  assert.match(start, /setDraft\(title\)/, "seed with the displayed title");
  assert.doesNotMatch(start, /setDraft\(storedName\)/, "the empty-when-unnamed seed must be gone");
});

test("submitting an untouched rename still does not persist the fallback", () => {
  // sidebar：未改动的判定保留
  assert.match(
    sidebar,
    /if \(renameValue === title \|\| name === \(session\.name \?\? ""\)\) return;/,
    "an untouched rename stays a no-op",
  );
  // strip：name 为空时，提交等于显示标题也不写盘
  const commit = strip.slice(strip.indexOf("const commit = useCallback"), strip.indexOf("const cancelEdit") > 0 ? undefined : undefined);
  assert.match(commit, /if \(!storedName\.trim\(\) && next === title\.trim\(\)\) \{/, "no fallback persistence");
});
