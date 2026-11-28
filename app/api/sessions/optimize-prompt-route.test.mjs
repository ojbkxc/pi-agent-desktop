// Route-level coverage for the prompt optimization API.
// The POST route validates the body and delegates to runOptimizePrompt;
// the DELETE route calls cancelOptimize. Pure prompt-building/cleaning logic
// is tested separately in lib/prompt-optimize.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const postRouteSrc = await readFileSync(
  new URL("./[id]/optimize-prompt/route.ts", import.meta.url),
  "utf8",
);
const deleteRouteSrc = await readFileSync(
  new URL("./[id]/optimize-prompt/[requestId]/route.ts", import.meta.url),
  "utf8",
);

test("POST route guards: isApiRequestAllowed + hasJsonContentType before reading body", () => {
  assert.match(postRouteSrc, /isApiRequestAllowed\(req\)/);
  assert.match(postRouteSrc, /hasJsonContentType\(req\)/);
  assert.match(postRouteSrc, /readJsonBody\(req\)/);
});

test("POST route validates requestId and prompt types", () => {
  assert.match(postRouteSrc, /typeof body\.requestId !== "string"/);
  assert.match(postRouteSrc, /typeof body\.prompt !== "string"/);
});

test("POST route rejects prompts that start with /", () => {
  assert.match(postRouteSrc, /isOptimizablePrompt\(prompt\)/);
});

test("POST route enforces max character count", () => {
  assert.match(postRouteSrc, /PROMPT_OPTIMIZE_MAX_CHARS/);
  assert.match(postRouteSrc, /status: 413/);
});

test("POST route returns requestId and optimizedPrompt on success", () => {
  assert.match(postRouteSrc, /requestId: body\.requestId/);
  assert.match(postRouteSrc, /optimizedPrompt/);
});

test("POST route returns 499 on client abort", () => {
  assert.match(postRouteSrc, /req\.signal\.aborted/);
  assert.match(postRouteSrc, /PROMPT_OPTIMIZE_CANCELLED/);
  assert.match(postRouteSrc, /status: 499/);
});

test("DELETE route calls cancelOptimize and returns requestId + cancelled", () => {
  assert.match(deleteRouteSrc, /cancelOptimize\(id, requestId\)/);
  assert.match(deleteRouteSrc, /requestId, cancelled/);
});

test("DELETE route guards with isApiRequestAllowed", () => {
  assert.match(deleteRouteSrc, /isApiRequestAllowed\(req\)/);
});

test("Both routes declare force-dynamic + nodejs runtime", () => {
  assert.match(postRouteSrc, /export const dynamic = "force-dynamic"/);
  assert.match(postRouteSrc, /export const runtime = "nodejs"/);
  assert.match(deleteRouteSrc, /export const dynamic = "force-dynamic"/);
  assert.match(deleteRouteSrc, /export const runtime = "nodejs"/);
});

test("Both routes only export the convention-named handlers (no stray exports)", () => {
  // route.ts files must only export GET/POST/DELETE/etc. — helper functions
  // live in lib/. Assert no other `export` statements.
  const postExports = postRouteSrc.match(/^export (async )?function \w+/gm) ?? [];
  assert.deepEqual(postExports.map((e) => e.replace(/^export (async )?function /, "")), ["POST"]);
  const deleteExports = deleteRouteSrc.match(/^export (async )?function \w+/gm) ?? [];
  assert.deepEqual(deleteExports.map((e) => e.replace(/^export (async )?function /, "")), ["DELETE"]);
});
