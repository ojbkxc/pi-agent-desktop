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
