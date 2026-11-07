import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("notification clicks open the session by id, never paint the captured snapshot", () => {
  // A notification can outlive its session (deleted elsewhere while it sat in
  // the tray). Opening via handleOpenSession re-checks the catalogue /
  // refetches and no-ops on failure; the raw snapshot must not reach
  // handleSelectSession from the click.
  assert.match(source, /if \(targetSession\) handleOpenSession\(targetSession\.id\);/);
  assert.doesNotMatch(source, /handleSelectSession\(targetSession\)/);
});
