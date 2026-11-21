/**
 * `readDefaultModel()` / `activeModelPayload()`：读默认模型，读不到就回答 null。
 *
 * 直接打纯函数而不是发 HTTP：`isApiRequestAllowed` 的 host/origin 判定在合成的
 * `Request` 上没有意义，而这里要验的是「文件形状 → 结果」这条映射。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});
const { activeModelPayload, readDefaultModel } = await jiti.import("./route.ts");

const DIRS = [];

function agentDirWith(contents) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-active-model-"));
  DIRS.push(dir);
  mkdirSync(dir, { recursive: true });
  if (contents !== undefined) writeFileSync(join(dir, "settings.json"), contents, "utf8");
  return dir;
}

test("a settings file naming a default model answers that model", () => {
  const dir = agentDirWith(JSON.stringify({ defaultModel: { provider: "deepseek", modelId: "deepseek-v4" } }));
  assert.deepEqual(readDefaultModel(dir), { provider: "deepseek", modelId: "deepseek-v4" });
  assert.equal(activeModelPayload(dir).model, "deepseek-v4");
});

test("no settings file is not an error: null", () => {
  const dir = agentDirWith(undefined);
  assert.equal(readDefaultModel(dir), null);
  assert.equal(activeModelPayload(dir).model, null);
});

test("a file without defaultModel answers null", () => {
  const dir = agentDirWith(JSON.stringify({ packages: [], shellPath: "D:\\Git\\bin\\bash.exe" }));
  assert.equal(readDefaultModel(dir), null);
});

test("unparsable JSON answers null instead of throwing", () => {
  const dir = agentDirWith("{ this is not json");
  assert.equal(readDefaultModel(dir), null);
});

test("a byte-order mark is allowed", () => {
  const dir = agentDirWith("\uFEFF" + JSON.stringify({ defaultModel: { provider: "p", modelId: "m" } }));
  assert.equal(readDefaultModel(dir)?.modelId, "m");
});

test("a half-written defaultModel answers null, never a guess", () => {
  assert.equal(readDefaultModel(agentDirWith(JSON.stringify({ defaultModel: { provider: "p" } }))), null);
  assert.equal(readDefaultModel(agentDirWith(JSON.stringify({ defaultModel: { provider: "", modelId: "m" } }))), null);
  assert.equal(readDefaultModel(agentDirWith(JSON.stringify({ defaultModel: "x" }))), null);
});

test("the payload is just the model id, never the provider", () => {
  const dir = agentDirWith(JSON.stringify({ defaultModel: { provider: "secret-provider", modelId: "m" } }));
  assert.deepEqual(Object.keys(activeModelPayload(dir)), ["model"]);
});

test.after(() => {
  for (const dir of DIRS) rmSync(dir, { recursive: true, force: true });
});
