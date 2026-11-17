import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 「新建目标」弹窗的纯逻辑：`buildGoalCommand` 与 Start 的可用性判据。
 * 不渲染（没有 DOM 环境）：组件里那一层就是这两条纯函数的薄封装。
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const mod = await jiti.import("./GoalCreateDialog.tsx");

test("buildGoalCommand：条件 + 间隔 ⇒ /goal <条件> --every 2h", () => {
  assert.equal(
    mod.buildGoalCommand({ condition: "npm test exits 0", repeat: "2h" }),
    "/goal npm test exits 0 --every 2h",
  );
});

test("buildGoalCommand：不写间隔 ⇒ 只有目标正文（连续续跑）", () => {
  assert.equal(
    mod.buildGoalCommand({ condition: "npm test exits 0", repeat: "" }),
    "/goal npm test exits 0",
  );
  assert.equal(
    mod.buildGoalCommand({ condition: "把页面做完", repeat: "不停迭代该项目" }),
    "/goal 把页面做完",
    "没有间隔前缀的重复栏是纯备注，不进命令",
  );
});

test("buildGoalCommand：注释文字不进命令（避免它变成目标正文的一部分）", () => {
  const command = mod.buildGoalCommand({ condition: "跑绿", repeat: "1d 不停迭代该项目" });
  assert.equal(command, "/goal 跑绿 --every 1d");
  assert.doesNotMatch(command, /不停迭代/);
});

test("buildGoalCommand：越界间隔不生成 --every（与 parseGoalRepeat 同一判据）", () => {
  assert.equal(mod.buildGoalCommand({ condition: "x", repeat: "5s" }), "/goal x");
  assert.equal(mod.buildGoalCommand({ condition: "x", repeat: "30d" }), "/goal x");
});

test("buildGoalCommand：两栏皆空 ⇒ 只有 /goal（调用方靠 canStart 拦住，不会发出去）", () => {
  assert.equal(mod.buildGoalCommand({ condition: "  ", repeat: "  " }), "/goal");
});

test("Start 的可用性判据直接取组件导出（不再复写公式）：有正文或有合法间隔", () => {
  // B-2 审计：此前这里把 `condition.trim().length > 0 || intervalMs > 0` 抄了一遍，
  // 组件里的判据改坏测试也不会红。现在组件与测试共用 `canStartGoal`——反向验证：
  // 把它改成恒 true，本用例立即失败。
  const cases = [
    { condition: "", repeat: "不停迭代该项目", usable: false },
    { condition: "npm test exits 0", repeat: "", usable: true },
    { condition: "", repeat: "2h", usable: true },
    { condition: "", repeat: "5s", usable: false, why: "非法间隔不算" },
    { condition: "  ", repeat: "  ", usable: false, why: "空白不算正文" },
  ];
  for (const item of cases) {
    assert.equal(mod.canStartGoal(item.condition, item.repeat), item.usable, JSON.stringify(item));
  }
  // 与 buildGoalCommand 的口径一致：能 Start ⇔ 命令不只是裸 /goal。
  assert.equal(mod.canStartGoal("", ""), false);
  assert.notEqual(mod.buildGoalCommand({ condition: "", repeat: "" }), "/goal ", "裸命令不会带尾部空格");
});

test("Start 按钮的真实 disabled 由同一判据驱动（渲染断言）", async () => {
  const React = await jiti.import("react");
  const { renderToStaticMarkup } = await jiti.import("react-dom/server");
  const { I18nProvider } = await jiti.import("@/hooks/useI18n");
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(mod.GoalCreateDialog, { open: true, onSubmit: () => {}, onCancel: () => {} }),
  ));
  // 打开时条件栏为空、重复栏预填「不停迭代该项目」（无间隔）→ Start 必须 disabled，
  // 证明组件的按钮状态直接来自 canStartGoal（而非测试里另算一遍）。
  assert.match(html, /class="goal-dialog-start native-primary-button"[^>]*disabled/, "空条件 + 无间隔 ⇒ Start 置灰");
  assert.doesNotMatch(html, /goal\.dialog\.title/, "不应渲染 i18n 键原文");
});

// a11y.md P2：Tab 不离开对话框、关闭后焦点归还 /goal 按钮。
test("源码哨兵：Esc/Tab/初始焦点/归还走共享 useModalDismiss（enabled 绑定 open）", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = (await readFile(new URL("./GoalCreateDialog.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(source, /import \{ useModalDismiss \} from "@\/hooks\/useModalDismiss"/);
  assert.match(source, /const panelRef = useModalDismiss<HTMLDivElement>\(onCancel, open\)/);
  assert.match(source, /ref=\{panelRef\} className="goal-dialog"/, "ref 挂面板，不挂遮罩");
  // 旧的自建 Esc 处理必须消失（capture/preventDefault 由 hook 统一做）。
  assert.doesNotMatch(source, /event\.key === "Escape" \{ event\.stopPropagation\(\); onCancel\(\); \}/);
  // Ctrl/Cmd+Enter 提交保留。
  assert.match(source, /event\.metaKey \|\| event\.ctrlKey/);
});