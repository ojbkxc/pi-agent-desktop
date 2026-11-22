import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { "@": process.cwd() } });
const { nextSeededCwd } = await jiti.import("./seed-default-cwd.ts");

test("nextSeededCwd：默认值只 seed 一次，用户清空后保持空（不回弹）", () => {
  // 首次默认值到达、字段为空 → 填入。
  assert.deepEqual(nextSeededCwd({ seeded: false, userEdited: false }, "", "/proj"), { seeded: true, value: "/proj" });
  // 已 seed + 用户清空 → 不回弹（旧逻辑 `(!cwd && defaultCwd) ? defaultCwd : null` 会填回 /proj）。
  assert.deepEqual(nextSeededCwd({ seeded: true, userEdited: true }, "", "/proj"), { seeded: true, value: null });
  // 已 seed 后再空也不再填。
  assert.deepEqual(nextSeededCwd({ seeded: true, userEdited: false }, "", "/proj"), { seeded: true, value: null });
  // 初始已有值 → 标记已 seed，不覆盖。
  assert.deepEqual(nextSeededCwd({ seeded: false, userEdited: false }, "/existing", "/proj"), { seeded: true, value: null });
  // 没有默认值 → 不动。
  assert.deepEqual(nextSeededCwd({ seeded: false, userEdited: false }, "", null), { seeded: false, value: null });
});

// 组件无 DOM 环境可驱动状态（仓库是 SSR-only，无 jsdom），故以源码守卫钉住
// 「不再每次渲染无条件回填 cwd」这一回归点；行为由上面的纯函数测试覆盖。
const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
for (const path of ["../components/AutofixView.tsx", "../components/CampaignView.tsx"]) {
  test(`${path} 改用一次性 seed，不再无条件回填 cwd`, () => {
    const text = source(path);
    assert.doesNotMatch(text, /if \(!cwd && defaultCwd\) setCwd\(defaultCwd\)/, "旧的每次渲染回填必须移除");
    assert.match(text, /nextSeededCwd/, "必须走一次性 seed 逻辑");
    assert.match(text, /cwdEditedRef\.current = true/, "用户编辑要打标记，清空后不回弹");
  });
}