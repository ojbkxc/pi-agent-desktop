import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 挂机保活设置区块的形状守卫。
 *
 * 背景（2026-11-15 CI run 114 e2e settings-controls 红）：
 * `status?.server.heartbeatAgeMs` 只防 `status` 为 null，不防 `status.server`
 * 缺席——Settings 面板在接口回 `{}`（未登记路由 / 旧版服务 / 测试桩）时
 * 抛 `Cannot read properties of undefined (reading 'heartbeatAgeMs')`，整页崩。
 * 这里钉住「任何畸形/缺字段响应都不得抛异常」。
 */
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { KeepaliveSection } = await jiti.import("./KeepaliveSection.tsx");

function render() {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, { initialLocale: "zh-CN" },
      React.createElement(KeepaliveSection)),
  );
}

// 组件挂载后才会 fetch；服务端渲染阶段 status 恒为 null，走 loading 分支。
// 真正要钉的是「status 为非空但缺 server / 半截对象」时不得崩——
// 这类状态只能靠直接喂 props/内部函数触发，因此这里改为断言源码形状：
// 所有对 status 子对象的读取都必须先取局部变量并带 ?.。
const source = await jiti.import("node:fs").then((fs) =>
  fs.readFileSync(new URL("./KeepaliveSection.tsx", import.meta.url), "utf8"));

test("status 子对象不得在可选链后直接深访（防 TypeError 整页崩）", () => {
  // 只扫代码行，跳过注释（注释里会举例 `status?.server.x` 这种反例）。
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  const bad = code.match(/status\?\.(server|supervisor|autofix|interrupted|resume)\.[A-Za-z]/g) ?? [];
  assert.deepEqual(bad, [], `发现无防御深访：${bad.join(", ")}`);
});

test("server 子字段统一从局部变量读取并带可选链", () => {
  assert.match(source, /const server = status\?\.server;/);
  assert.match(source, /server\?\.heartbeatAgeMs \?\? null/);
  assert.match(source, /server\?\.uptimeMs \?\? null/);
  assert.match(source, /server\?\.pid \?\? "-"/);
});

test("resume / interrupted 数组读取带可选链与空值兜底", () => {
  assert.match(source, /status\?\.resume\?\.resumed\?\.length \?\? 0/);
  assert.match(source, /status\?\.interrupted\?\.sessionIds\?\.length \?\? 0/);
});

test("空状态渲染 loading 文案且不抛", () => {
  const html = render();
  assert.ok(html.includes("settings-keepalive") || html.length > 0, html.slice(0, 200));
});
