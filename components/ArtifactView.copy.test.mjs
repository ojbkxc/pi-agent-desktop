import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./ArtifactView.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("artifact copy goes through the shared feedback hook", () => {
  // interaction.md P2 / state.md P2：原来只传成功回调，剪贴板被拒时既无 UI 反馈又产生
  // unhandled rejection；「已复制」用裸 setTimeout 复位，连点两次会提前消失。
  assert.match(source, /import \{ useCopyFeedback \} from "@\/hooks\/useCopyFeedback"/);
  assert.match(source, /const \{ copied, copy: copyFeedback \} = useCopyFeedback\(\)/);
  assert.match(source, /void copyFeedback\(version\.content\)/);
  assert.doesNotMatch(source, /setTimeout\(\(\) => setCopied\(false\), 1500\)/);
  assert.doesNotMatch(source, /from "@\/lib\/clipboard"/);
});
