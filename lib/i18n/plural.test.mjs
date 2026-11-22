import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { interpolateMessage, resolvePluralBlocks, translateMessage } = await jiti.import("./format.ts");
const { forkLocalePlugins } = await jiti.import("./locale-plugins.ts");

const messagesOf = (id) => forkLocalePlugins.find((plugin) => plugin.id === id).messages;
const t = (id, key, params) => translateMessage(id, key, {
  en: messagesOf("en"),
  "zh-CN": messagesOf("zh-CN"),
  "zh-TW": messagesOf("zh-TW"),
}, params ?? {});

// ─────────────────────────────────────────────────────────────────────────────
// 本轮修复：计数文案的单复数（英文下 1 个成员曾经也显示 "members"）。
//
// 为什么改在插值层：消息是纯字符串，计数参数**只有插值这一步**可见，消息字典拿不到
// count。所以 locale-plugins 只声明两种词形（`{plural(count):单数:复数}`），由
// lib/i18n/format.ts 选形。
// ─────────────────────────────────────────────────────────────────────────────

test("resolvePluralBlocks：1 取单数，其余（含 0）取复数", () => {
  const message = "{count} {plural(count):member:members}";
  assert.equal(resolvePluralBlocks(message, { count: 1 }), "{count} member");
  assert.equal(resolvePluralBlocks(message, { count: 0 }), "{count} members");
  assert.equal(resolvePluralBlocks(message, { count: 2 }), "{count} members");
  assert.equal(resolvePluralBlocks(message, { count: "1" }), "{count} member", "数字字符串也认");
  // 没有计数参数 / 不是数字：原样保留，让调用方看见漏传，而不是猜一个形态。
  assert.equal(resolvePluralBlocks(message, {}), message);
  assert.equal(resolvePluralBlocks(message, { count: "many" }), message);
  // 没有复数块的消息零开销、零改动。
  assert.equal(resolvePluralBlocks("no plural here", { count: 5 }), "no plural here");
});

test("interpolateMessage：先选词形再插值，一次调用出完整文案", () => {
  const message = "{count} {plural(count):member:members}";
  assert.equal(interpolateMessage(message, { count: 1 }), "1 member");
  assert.equal(interpolateMessage(message, { count: 7 }), "7 members");
  // 既有纯 {token} 消息行为不变。
  assert.equal(interpolateMessage("Hello, {name} ({count})", { name: "Pi", count: 2 }), "Hello, Pi (2)");
  assert.equal(interpolateMessage("keep {token}", {}), "keep {token}");
});

test("teams.plan.memberCount：中英文在 1 与多个成员时都正确", () => {
  assert.equal(t("en", "teams.plan.memberCount", { count: 1 }), "1 member");
  assert.equal(t("en", "teams.plan.memberCount", { count: 3 }), "3 members");
  assert.equal(t("en", "teams.plan.memberCount", { count: 0 }), "0 members");
  // 中文没有单复数变化：两种计数同一形态，且都不残留复数块语法。
  assert.equal(t("zh-CN", "teams.plan.memberCount", { count: 1 }), "1 名成员");
  assert.equal(t("zh-CN", "teams.plan.memberCount", { count: 3 }), "3 名成员");
  assert.equal(t("zh-TW", "teams.plan.memberCount", { count: 1 }), "1 名成員");
  assert.equal(t("zh-TW", "teams.plan.memberCount", { count: 3 }), "3 名成員");
  for (const id of ["en", "zh-CN", "zh-TW"]) {
    for (const count of [1, 2]) {
      const text = t(id, "teams.plan.memberCount", { count });
      assert.doesNotMatch(text, /plural\(/, `${id}/${count} 不露出复数块语法`);
      assert.doesNotMatch(text, /\{count\}/, `${id}/${count} 计数已插值`);
    }
  }
});

test("静态：locale-plugins 的成员数文案声明了单复数，旧写法不再存在", () => {
  const source = readFileSync(join(process.cwd(), "lib", "i18n", "locale-plugins.ts"), "utf8");
  assert.match(
    source,
    /"teams\.plan\.memberCount": "\{count\} \{plural\(count\):member:members\}"/,
    "英文声明单数/复数两种词形",
  );
  assert.doesNotMatch(source, /"teams\.plan\.memberCount": "\{count\} members"/, "旧的「恒复数」写法必须消失");
  // 复数块语法不得引入内层花括号（否则 usage.test 的占位符门禁会误报）。
  const message = messagesOf("en")["teams.plan.memberCount"];
  assert.doesNotMatch(message, /\{plural\([^)]*\):[^{}]*\{[^{}]*\}/, "复数块内层不能有花括号占位符");
});
