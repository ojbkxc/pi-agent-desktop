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
const {
  AgentTeamTaskDetail,
  AgentTeamTaskDetailBody,
  taskDetailDrawerGeometry,
  clampTaskDetailRight,
  TASK_DETAIL_NARROW_BREAKPOINT,
} = await jiti.import("./AgentTeamTaskDetail.tsx");
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
  // 门户包装依赖 document，SSR 渲不出内容；内容本体单独导出，测试直接渲染它。
  return renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(AgentTeamTaskDetailBody, props),
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

// ── 覆盖层修复（工作台层叠封顶/裁切的真缺陷）───────────────────────────────
// 实测：`.scheduled-view` 是 position:absolute + z-index:30 + overflow:hidden 的层叠
// 上下文兼裁切盒，抽屉留在树内时既被裁又永远压在顶栏（--z-chrome=90）之下。
// 修法 = 门户到 body（脱离裁剪盒与层叠上下文）+ fixed 定位 + 层叠令牌。
test("抽屉内容：fixed 定位 + --z-popover 令牌 + 视口夹取宽度，无未定义 --z-drawer", () => {
  const html = render({
    snapshot: snapshot({ members: [member("impl", "impl")], tickets: [ticket("t1", { ownerId: "impl" })] }),
    ticketId: "t1",
    onClose: () => {},
    onSelectMember: () => {},
  });
  assert.match(html, /position:fixed/, "门户后必须 fixed（absolute 会被祖先裁切盒裁掉）");
  assert.match(html, /z-index:var\(--z-popover\)/, "层级只用令牌，且需高于顶栏 90");
  assert.match(html, /max-width:min\(360px/, "窄视口要有夹取，不能溢出到侧栏");
  assert.doesNotMatch(html, /--z-drawer/, "全仓未定义 --z-drawer，不得留下未定义变量");
  assert.doesNotMatch(html, /z-index:40\b/, "literal z-index 40 在门户后会被顶栏盖住");
});

test("抽屉经 createPortal 挂到 document.body（脱离 #view 的层叠上下文与 overflow 裁剪）", async () => {
  assert.equal(typeof AgentTeamTaskDetail, "function", "门户包装必须导出");
  const source = await readFile(new URL("./AgentTeamTaskDetail.tsx", import.meta.url), "utf8");
  assert.match(source, /createPortal\(/, "必须门户化");
  assert.match(source, /document\.body/, "门户目标必须是 document.body");
  assert.match(source, /typeof document === "undefined"/, "SSR 首帧无 document，必须守卫");
});

// ── css.md P2 #7：窄屏溢出（偏移量不夹）─────────────────────────────────────
test("几何：窄视口（< 640）改左右各 8 的全宽低位抽屉，不再把抽屉推出屏", () => {
  assert.equal(TASK_DETAIL_NARROW_BREAKPOINT, 640);
  for (const width of [320, 375, 480, 639]) {
    const geo = taskDetailDrawerGeometry(true, true, width);
    assert.equal(geo.left, 8, `left 夹到 8 @${width}`);
    assert.equal(geo.right, 8, `right 夹到 8 @${width}`);
    assert.equal(geo.bottom, 8);
    assert.equal(geo.width, "auto", "全宽（由 left/right 决定）");
    assert.equal(geo.maxWidth, "none");
  }
  // 375×667 的原缺陷：left = 375 − 68 − 359 ≈ −52。新几何下恒不小于 8。
  const geo375 = taskDetailDrawerGeometry(true, false, 375);
  assert.ok(geo375.left >= 8);
  // 通信栏开着时旧实现 right:396 直接离屏；新几何下同样贴边。
  assert.equal(taskDetailDrawerGeometry(true, true, 375).right, 8);
});

test("几何：宽视口维持右下角，但右偏移动量按视口夹取（左边缘 ≥ 8）", () => {
  // 960 宽：原偏移 68 / 396 都放得下。
  assert.equal(clampTaskDetailRight(false, 960), 68);
  assert.equal(clampTaskDetailRight(true, 960), 396);
  // 768 宽 + dockOpen：360 + 396 = 756 ≤ 768 − 8 ⇒ 396 原样保留。夹取从 764 起生效
  // （right = vw − 368 的那个点）。
  assert.equal(clampTaskDetailRight(true, 768), 396);
  assert.equal(clampTaskDetailRight(true, 764), 396);
  assert.equal(clampTaskDetailRight(true, 763), 395);
  // 700 宽 + dockOpen：原 396 会让 left = 700 − 396 − 360 = −56（出屏）⇒ 夹到 332。
  assert.equal(clampTaskDetailRight(true, 700), 332);
  // 下限 8：视口再窄也不会把抽屉推成负 left。
  assert.equal(clampTaskDetailRight(false, 400), 32);
  const geo = taskDetailDrawerGeometry(false, true, 700);
  assert.equal(geo.width, 360);
  assert.equal(geo.left, "auto");
  assert.equal(geo.right, 332);
});

test("窄屏分支接入：组件用 useIsMobile 喂几何，且不再有未夹取的裸偏移", async () => {
  const source = await readFile(new URL("./AgentTeamTaskDetail.tsx", import.meta.url), "utf8");
  assert.match(source, /useIsMobile\(\)/, "窄屏形态来自共享断点 hook");
  assert.match(source, /taskDetailDrawerGeometry\(\s*narrow/, "几何由纯函数计算");
  // 旧的裸偏移（dockOpen ? 396 : 68）必须消失——它正是溢出根因。
  assert.doesNotMatch(source, /right:\s*dockOpen \? 396 : 68/, "偏移必须夹取，不能再裸写");
});

// ── a11y.md P2：非模态抽屉关闭后把焦点还给任务卡 ──────────────────────────────
test("焦点归还：记录打开前的 activeElement，关闭时仅在焦点仍在抽屉内/落到 body 时归还", async () => {
  const source = await readFile(new URL("./AgentTeamTaskDetail.tsx", import.meta.url), "utf8");
  assert.match(source, /openerRef\.current = .*document\.activeElement/s, "打开前记录 opener");
  assert.match(source, /asideRef\.current\?\.focus\(\{ preventScroll: true \}\)/, "打开时聚焦自身");
  // 归还条件与 focusModalPanel 同口径：焦点仍在抽屉内 / 落到 body / 丢失才归还。
  assert.match(source, /asideRef\.current\.contains\(active\)/, "焦点在抽屉内才归还");
  assert.match(source, /active === document\.body/, "焦点落到 body 才归还");
  assert.match(source, /opener\.isConnected/, "opener 已卸载就不抢焦点");
  // 非模态：不得加焦点陷阱（不能引入 useModalDismiss）。
  assert.doesNotMatch(source, /useModalDismiss/, "抽屉是非模态，不要焦点陷阱");
});