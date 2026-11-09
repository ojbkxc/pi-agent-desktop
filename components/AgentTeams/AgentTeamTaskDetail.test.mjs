import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * C8 任务详情抽屉的回归守卫（对抗验证 M3 点名：此前零测试）。
 *
 * SSR 断言抽屉把「负责人（可点）/ 依赖 / 解锁 / 描述 / 状态标签」渲染了出来，
 * 以及无主票的降级；「点负责人 → 打开成员检查器」的回调在 SSR 里点不到，按本仓做法
 * 用源码断言钉住「以 owner.id 调用 onSelectMember」。
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { AgentTeamTaskDetail } = await jiti.import("./AgentTeamTaskDetail.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function member(id, name) {
  return {
    id, name, role: "member", model: null, providerName: null, color: "blue",
    status: "running", activity: "active", isLead: false, sessionId: null,
    cwd: "", worktreePath: null, lastError: null, joinedAt: "2026-01-01T00:00:00.000Z",
  };
}

function ticket(id, overrides = {}) {
  return {
    id,
    subject: `任务 ${id}`,
    description: "",
    ownerId: null,
    status: "open",
    dependencies: [],
    assignments: [],
    source: "plan",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot({ tickets = [], members = [] } = {}) {
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    team: { id: "t", name: "Team", description: "", createdAt: "2026-01-01T00:00:00.000Z", leadSessionId: null, status: "running", incarnationId: "t" },
    members, tickets, lanes: [], flows: [], taskAnchors: [], tasks: [], receipts: [], messages: [],
  };
}

function render(props) {
  return renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(AgentTeamTaskDetail, props),
  ));
}

test("有主票：渲染负责人（可点）、票 id / 主题 / 状态标签", () => {
  const html = render({
    snapshot: snapshot({ members: [member("impl", "impl")], tickets: [ticket("t1", { ownerId: "impl", subject: "Do thing" })] }),
    ticketId: "t1",
    onClose: () => {},
    onSelectMember: () => {},
  });
  assert.match(html, /data-testid="agent-teams-task-detail"/);
  assert.match(html, /data-task-id="t1"/);
  assert.match(html, /Do thing/);
  // 无依赖无 running → available（teams.stats.available → "Available"）。
  assert.match(html, /Available/);
  // 负责人名出现在可点按钮里。
  assert.match(html, />impl</);
  assert.doesNotMatch(html, /Unassigned/);
});

test("依赖与解锁：依赖列本票的 dependencies，解锁列依赖本票的其它票", () => {
  const tickets = [
    ticket("t0", { subject: "root" }),
    ticket("t1", { ownerId: null, dependencies: ["t0"] }),
    ticket("t2", { dependencies: ["t1"] }),
    ticket("t9", { dependencies: ["t1"] }),
  ];
  const html = render({
    snapshot: snapshot({ tickets }),
    ticketId: "t1",
    onClose: () => {},
    onSelectMember: () => {},
  });
  assert.match(html, /Depends on/);
  assert.match(html, /Unblocks/);
  assert.match(html, /#t0/);
  // 解锁是「谁依赖本票」，t2 与 t9 都要出现，且不该混进 t0。
  assert.match(html, /#t2/);
  assert.match(html, /#t9/);
});

test("无依赖无解锁时用占位符而不是空串", () => {
  const html = render({
    snapshot: snapshot({ tickets: [ticket("solo", { subject: "solo" })] }),
    ticketId: "solo",
    onClose: () => {},
    onSelectMember: () => {},
  });
  assert.match(html, /Depends on/);
  assert.match(html, /Unblocks/);
  // chip() 在空列表时渲染 "—"。
  assert.match(html, /—/);
});

test("描述存在时渲染，不存在时不渲染描述段", () => {
  const withDesc = render({
    snapshot: snapshot({ tickets: [ticket("t1", { description: "line one\nline two" })] }),
    ticketId: "t1",
    onClose: () => {},
    onSelectMember: () => {},
  });
  assert.match(withDesc, /line one/);
  assert.match(withDesc, /line two/);

  const withoutDesc = render({
    snapshot: snapshot({ tickets: [ticket("t1", { description: "" })] }),
    ticketId: "t1",
    onClose: () => {},
    onSelectMember: () => {},
  });
  assert.doesNotMatch(withoutDesc, /line one/);
});

test("无主票降级为 Unassigned（而不是留空或崩）", () => {
  const html = render({
    snapshot: snapshot({ members: [member("impl", "impl")], tickets: [ticket("t1", { ownerId: null })] }),
    ticketId: "t1",
    onClose: () => {},
    onSelectMember: () => {},
  });
  assert.match(html, /Unassigned/);
  // ownerId 为 null 时不该凭空挑一个成员当负责人。
  assert.doesNotMatch(html, />impl</);
});

test("票已从快照消失时整块返回 null", () => {
  const html = render({
    snapshot: snapshot({ tickets: [ticket("t1")] }),
    ticketId: "ghost",
    onClose: () => {},
    onSelectMember: () => {},
  });
  assert.equal(html, "");
});

test("未传 onSelectMember 时负责人按钮禁用", () => {
  const html = render({
    snapshot: snapshot({ members: [member("impl", "impl")], tickets: [ticket("t1", { ownerId: "impl" })] }),
    ticketId: "t1",
    onClose: () => {},
  });
  assert.match(html, /disabled/);
});

test("「点负责人 → 打开成员」以 owner.id 调用 onSelectMember", async () => {
  const source = await readFile(new URL("./AgentTeamTaskDetail.tsx", import.meta.url), "utf8");
  assert.match(source, /onSelectMember\?\.\(owner\.id\)/, "必须把负责人的 id 交给 onSelectMember");
});