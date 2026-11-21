import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./route.ts");
const { autoPresetPayload } = await jiti.import("@/lib/purge/auto-preset.ts");
const { defaultPurgeSettings } = await jiti.import("@/lib/purge/types.ts");
const { BUILTIN_PRESETS } = await jiti.import("@/lib/purge/preset-catalog.ts");

// 总闸默认打开，所以「关着」这一组必须显式关闭。
const OFF = { ...defaultPurgeSettings(), enabled: false };

function payload(overrides, model) {
  return autoPresetPayload({ ...OFF, enabled: true, auto_preset: true, ...overrides }, model);
}

test("关着的时候报告 pick 不到任何预设", () => {
  assert.equal(autoPresetPayload(OFF, "deepseek-v4").preset, null);
  assert.equal(autoPresetPayload(OFF, "deepseek-v4").active, false);
  // 总开关开着但自动套用关着：同样不套。
  assert.equal(payload({ auto_preset: false }, "deepseek-v4").preset, null);
});

test("打开以后按模型回答将套用的那一条", () => {
  const body = payload({}, "deepseek-v4");
  assert.equal(body.active, true);
  assert.equal(body.model, "deepseek-v4");
  assert.equal(body.mode, "prepend");
  assert.equal(body.match, "exact");
  assert.equal(body.preset?.match, "exact");
  assert.doesNotMatch(body.preset.id, /^$/, "预设 id 不能为空");
  assert.equal(typeof body.preset.title, "string");

  // 固定 id 时如实报告来源。
  const pinned = payload({ auto_preset_id: BUILTIN_PRESETS[0].id }, null);
  assert.equal(pinned.preset?.match, "manual");
  assert.equal(pinned.pinned, BUILTIN_PRESETS[0].id);
});

test("读不到模型时如实回答 null，不编一个", () => {
  const body = payload({}, null);
  assert.equal(body.model, null);
  assert.equal(body.preset, null);
});

test("GET 拒绝跨站请求，正常请求带上 no-store", async () => {
  const denied = await GET(new Request("http://localhost/api/purge/auto-preset", {
    headers: { Host: "localhost", Origin: "http://evil.example.com" },
  }));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "Untrusted API request");

  const ok = await GET(new Request("http://localhost/api/purge/auto-preset", {
    headers: { Host: "localhost" },
  }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const body = await ok.json();
  assert.ok("preset" in body);
  assert.ok("model" in body);
});
