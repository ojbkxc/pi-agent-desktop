import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const view = await read("./CampaignView.tsx");
const row = await read("./CampaignSidebarRow.tsx");
const sidebar = await read("./SessionSidebar.tsx");
const appShell = await read("./AppShell.tsx");
const css = await read("../app/native-theme.css");

/**
 * P1「项目战役」最简 UI 的接线契约（docs/agents/fork-long-run-campaign.md §8/§10）。
 * 这些都是 clean merge 不会自愈的跨文件接线，任何一条掉了，页面会静默失去入口或能力。
 */

test("the create form makes the cost ceiling required", () => {
  // 成本闸前置：字段存在、提示必填，且 Start 在没有成本时禁用。
  assert.match(view, /id="campaign-cost"/);
  assert.match(view, /t\("campaign\.costLabel"\)/);
  assert.match(view, /t\("campaign\.costHint"\)/);
  assert.match(view, /Number\(cost\)/);
  assert.match(view, /campaign\.error\.maxTotalCostUsdRequired/);
  // disabled 条件里包含 cost。
  assert.match(view, /disabled=\{busy !== null \|\| !objective\.trim\(\) \|\| !cwd\.trim\(\) \|\| !cost\.trim\(\)\}/);
});

test("the backlog editor posts items with verify commands and dependsOn", () => {
  assert.match(view, /verifyCommand: string;/);
  assert.match(view, /campaignRequest<\{ campaign: Campaign \}>\("", \{ method: "POST", body: JSON\.stringify\(input\) \}\)/);
  // dependsOn 文本按逗号拆分，引用 store 生成的 item-N。
  assert.match(view, /item\.dependsOn\.split\(","\)/);
});

test("progress, cost and rounds are projected from the store shape", () => {
  assert.match(view, /import \{[^}]*campaignProgress[^}]*\} from "@\/lib\/campaign\/types"/s);
  assert.match(view, /const progress = campaignProgress\(campaign\)/);
  assert.match(view, /className="campaign-progress"/);
  assert.match(view, /t\("campaign\.itemsProgress"/);
  assert.match(view, /t\("campaign\.roundOf"/);
  assert.match(view, /t\("campaign\.costOf"/);
});

test("pause / stop / resume / delete actions hit the [id] route", () => {
  for (const action of ["pause", "stop", "resume"]) {
    assert.match(view, new RegExp(`JSON\\.stringify\\(\\{ action: "${action}" \\}\\)`));
  }
  assert.match(view, /method: "DELETE"/);
  assert.match(view, /t\("campaign\.deleteConfirm"\)/);
});

test("the sidebar row and AppShell route the campaigns view", () => {
  assert.match(row, /t\("sidebar\.campaigns"\)/);
  assert.match(row, /sidebar-scheduled-row/);
  assert.match(sidebar, /<CampaignSidebarRow active=\{campaignsOpen\} onOpen=\{onOpenCampaigns\} \/>/);
  assert.match(appShell, /value === "campaigns"/);
  assert.match(appShell, /const handleOpenCampaigns = useCallback\(\(\) => openWorkspaceView\("campaigns"\)/);
  assert.match(appShell, /const CampaignView = dynamic\(\(\) => import\("\.\/CampaignView"\)/);
  assert.match(appShell, /\{campaignsOpen && \(\s*<CampaignView/);
});

test("campaign CSS lives in native-theme.css without new !important", () => {
  assert.match(css, /\.campaign-progress-fill \{/);
  assert.match(css, /\.campaign-item-draft \{/);
  const block = css.slice(css.indexOf(".campaign-items-editor"), css.indexOf(".campaign-facts") + 40);
  assert.doesNotMatch(block, /!important/);
});
