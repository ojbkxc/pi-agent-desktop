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
