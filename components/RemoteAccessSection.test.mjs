import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./RemoteAccessSection.tsx", import.meta.url), "utf8");

// state.md / interaction.md P2（该文件原先无 owner，随 Server/Relay 一并收口）：
// CopyRow 的裸 setTimeout 不保存句柄，连点复制会让「已复制」提前消失；失败也没有
// 反馈且产生未处理 rejection。统一换共享 useCopyFeedback。
test("the remote-access copy row uses the shared copy-feedback hook", () => {
  assert.match(source, /import \{ useCopyFeedback \} from "@\/hooks\/useCopyFeedback"/);
  assert.match(source, /const \{ copied, failed, copy \} = useCopyFeedback\(\)/);
  assert.match(source, /void copy\(value\)/);
  assert.match(source, /t\("i18n\.copyFailed"\)/);
  assert.doesNotMatch(source, /setCopied/);
});
