import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./RelaySection.tsx", import.meta.url), "utf8");

test("device removal confirms through the shared dialog, not a native window.confirm", () => {
  // The Remove button opens the shared ChatConfirmDialog (as SessionSidebar's
  // delete does), keeping the same relay.removeConfirm copy.
  assert.doesNotMatch(source, /window\.confirm/);
  assert.match(source, /import \{ ChatConfirmDialog \} from "\.\/ChatConfirmDialog"/);
  assert.match(source, /<ChatConfirmDialog/);
  assert.match(source, /t\("relay\.removeConfirm", \{ name: deviceToRemove\.name \}\)/);
});

// state.md P2：裸 .then + 不保存句柄的 setTimeout 会吞掉复制失败（未处理
// rejection）、连点时前一个 timer 提前清掉后一个「已复制」。统一换共享 hook。
test("copy feedback comes from the shared hook", () => {
  assert.match(source, /import \{ useCopyFeedback \} from "@\/hooks\/useCopyFeedback"/);
  assert.match(source, /const \{ copied, failed: copyFailed, copy \} = useCopyFeedback\(\)/);
  assert.match(source, /void copy\(pairing\.url\)/);
  assert.match(source, /t\("i18n\.copyFailed"\)/);
  assert.doesNotMatch(source, /window\.setTimeout\(\(\) => setCopied\(false\)/);
});
