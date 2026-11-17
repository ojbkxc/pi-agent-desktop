import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ModelSelector.tsx", import.meta.url), "utf8");

test("does not autofocus the model filter on mobile", () => {
  // Autofocus would open the on-screen keyboard as soon as the picker opens.
  assert.match(source, /aria-label=\{t\("chat\.filterModels"\)\}[\s\S]*?autoFocus=\{!isMobile\}/);
  assert.doesNotMatch(source, /^\s*autoFocus\s*$/m);
});

test("portals the fixed popup out of the settings dialog", () => {
  // The Settings surface keeps a transform from its entry animation (`both`), so a
  // fixed popup rendered inside it is offset by the dialog corner and clipped by
  // its overflow — only when reduced motion is off. The popup lays itself out with
  // viewport coordinates and therefore has to live on <body>.
  assert.match(source, /import \{ createPortal \} from "react-dom";/);
  assert.match(source, /return createPortal\(/);
  assert.match(source, /document\.body,\r?\n\s*\);\r?\n\s*\}\)\(\)\}/);
});
