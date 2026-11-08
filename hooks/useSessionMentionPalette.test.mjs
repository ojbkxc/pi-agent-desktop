import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

// d5-26：该 hook 的索引 fetch 是跨查询复用的轻量索引——守卫必须是「仅卸载置位」，
// 不能是 effect cleanup 的 cancelled 标志（那会随每次键入把仍想要的 fetch 误杀）。
// hook 本体依赖渲染器，无法在 node --test 里跑；这里用源码哨兵钉住守卫形态。

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
await jiti.import("./useSessionMentionPalette.ts"); // 能加载（连带其依赖链）即是回归的一部分

const source = (await readFile(new URL("./useSessionMentionPalette.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("the session index fetch is guarded against setState after unmount (d5-26)", () => {
  // 守卫只随卸载置位（空依赖 cleanup），不随 hashQuery/cwd/sessionIndex 变化置位。
  assert.match(source, /const disposedRef = useRef\(false\);/);
  assert.match(source, /useEffect\(\(\) => \(\) => \{[^}]*disposedRef\.current = true;[^}]*\}, \[\]\);/s);
  assert.match(source, /if \(disposedRef\.current\) return;\s*\n\s*const entries =/);
  // 失败仍保持静默（下一次键入 hashQuery 变化会重试——v2 复核结论），但不许是裸空块。
  assert.match(source, /\.catch\(\(\) => \{[^}]*\}\)/s);
});

test("the fetch stays shared across query keystrokes — no per-keystroke cancellation (d5-26)", () => {
  // 哨兵反面：不许出现随依赖清理置位 cancelled 的形态（那会把索引 fetch 误杀成永不落地）。
  assert.doesNotMatch(source, /let cancelled = false;[\s\S]*return \(\) => \{\s*cancelled = true;/);
});
