import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  TeamMemberModelPanel,
  MemberModelReceipts,
  resolveModelRef,
  buildMemberModelBody,
  groupModelResults,
} = await jiti.import("./TeamMemberModelPanel.tsx");
const { buildModelCatalog } = await jiti.import("@/hooks/useModelCatalog.ts");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (element) => renderToStaticMarkup(
  React.createElement(I18nProvider, { initialLocale: "en" }, element),
);

const catalog = buildModelCatalog({
  modelList: [
    { id: "claude-sonnet", name: "Claude Sonnet", provider: "zenmux" },
    { id: "gpt-5", name: "GPT-5", provider: "openai" },
  ],
}, { allEnabled: true, providers: [] });

test("resolveModelRef maps 'provider/modelId' back through the catalog (no string split)", () => {
  assert.deepEqual(resolveModelRef(catalog.entries, "zenmux/claude-sonnet"), { provider: "zenmux", modelId: "claude-sonnet" });
  assert.equal(resolveModelRef(catalog.entries, "ghost/x"), null);
  assert.equal(resolveModelRef(catalog.entries, null), null);
});

test("buildMemberModelBody dedupes members and requires a model", () => {
  assert.deepEqual(
    buildMemberModelBody(["a", "a", "b"], { provider: "zenmux", modelId: "claude-sonnet" }),
    { memberIds: ["a", "b"], provider: "zenmux", modelId: "claude-sonnet" },
  );
  assert.equal(buildMemberModelBody(["a"], null), null);
});

test("groupModelResults keeps applied / saved / failed apart and falls back to memberId", () => {
  const grouped = groupModelResults([
    { memberId: "a", name: "impl", status: "applied" },
    { memberId: "b", name: "qa", status: "saved" },
    { memberId: "c", name: null, status: "failed", reason: "模型不存在" },
  ]);
  assert.deepEqual(grouped.applied, ["impl"]);
  assert.deepEqual(grouped.saved, ["qa"]);
  assert.deepEqual(grouped.failed, [{ name: "c", reason: "模型不存在" }]);
});

test("MemberModelReceipts renders all three states with reasons, never a single success", () => {
  const html = render(React.createElement(MemberModelReceipts, {
    results: [
      { memberId: "a", name: "impl", status: "applied" },
      { memberId: "b", name: "qa", status: "saved" },
      { memberId: "c", name: "idle", status: "failed", reason: "模型不存在" },
    ],
  }));
  assert.match(html, /data-status="applied"/);
  assert.match(html, /data-status="saved"/);
  assert.match(html, /data-status="failed"/);
  assert.match(html, /模型不存在/, "失败原因如实透出");
  assert.match(html, /impl/);
  assert.match(html, /qa/);
});

test("batch panel renders the member picker and the single-select ModelPicker", () => {
  const html = render(React.createElement(TeamMemberModelPanel, {
    team: "demo",
    members: [{ id: "a", name: "impl" }, { id: "b", name: "qa" }],
    memberIds: ["a"],
    mode: "batch",
    onClose: () => {},
  }));
  assert.match(html, /data-mode="batch"/);
  assert.match(html, /team-member-model-member-list/);
  assert.match(html, /model-picker/, "复用 ModelPicker");
  assert.match(html, /class="team-member-model-member is-selected"/, "初选成员为选中态");
  assert.match(html, /team-member-model-submit/);
});

test("single panel shows the member name and no member picker", () => {
  const html = render(React.createElement(TeamMemberModelPanel, {
    team: "demo",
    members: [{ id: "a", name: "impl" }],
    memberIds: ["a"],
    mode: "single",
    onClose: () => {},
  }));
  assert.match(html, /data-mode="single"/);
  assert.doesNotMatch(html, /team-member-model-member-list/);
  assert.match(html, /team-member-model-single[^>]*>impl</);
});

// 覆盖层修复：面板是成员列表后的普通文档流块，常落在折叠线下（够不着）。修法是
// 打开即 scrollIntoView + 聚焦，并支持焦点在面板内时 Esc 关闭。挂载副作用无 DOM
// 测不了，这里断言几何/可达性：面板可聚焦（tabindex=-1）、语义 role=group 保留；
// 滚动与 Esc 的实际行为交给源码哨兵（滚动需布局，node --test 无 jsdom，无法行为化）。
test("面板可聚焦（tabindex=-1）且保留 role=group / 提交与关闭按钮", () => {
  const html = render(React.createElement(TeamMemberModelPanel, {
    team: "demo",
    members: [{ id: "a", name: "impl" }],
    memberIds: ["a"],
    mode: "single",
    onClose: () => {},
  }));
  assert.match(html, /class="team-member-model-panel"/);
  assert.match(html, /tabindex="-1"/, "打开时应能接收焦点（scrollIntoView + focus）");
  assert.match(html, /role="group"/);
  assert.match(html, /team-member-model-submit/);
  assert.match(html, /team-member-model-cancel/);
});

test("打开即滚动到可见 + Esc 关闭接线（滚动需布局，用源码哨兵钉住）", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./TeamMemberModelPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /scrollIntoView\(\{ block: "nearest" \}\)/, "折叠线以下的面板要滚进视口");
  assert.match(source, /node\.focus\(\{ preventScroll: true \}\)/, "打开即聚焦");
  assert.match(source, /event\.key === "Escape"[\s\S]*?onClose\(\)/, "焦点在面板内时 Esc 关闭");
});
