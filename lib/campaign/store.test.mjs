import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Campaign 落盘：原子写、坏 JSON 降级、UUID 校验、数量上限、读-改-写。
 * 全部走临时 agentDir，不碰真实 ~/.pi/agent。
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const store = await jiti.import("./store.ts");
const types = await jiti.import("./types.ts");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const validInput = (over = {}) => ({
  objective: "把项目推进到可发布",
  cwd: "/tmp/project",
  maxTotalCostUsd: 5,
  items: [
    { title: "a", instruction: "do a", verifyCommand: "npm test" },
    { title: "b", instruction: "do b", verifyCommand: "npm test", dependsOn: ["item-1"] },
  ],
  ...over,
});

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-campaign-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function assertValidationReason(fn, reason) {
  assert.throws(fn, (error) => error.name === "CampaignValidationError" && error.reason === reason);
}

test("createCampaign 写入 queued 战役并可 list/get 回读", async (t) => {
  const agentDir = await tempDir(t);
  const created = store.createCampaign(validInput(), agentDir);

  assert.equal(created.version, 1);
  assert.match(created.id, UUID_RE);
  assert.equal(created.status, "queued");
  assert.equal(created.currentItemId, null);
  assert.equal(created.spentCostUsd, 0);
  assert.equal(created.totalRounds, 0);
  assert.equal(created.maxTotalCostUsd, 5);
  assert.equal(created.maxTotalRounds, types.CAMPAIGN_MAX_TOTAL_ROUNDS);
  assert.equal(created.maxItems, types.CAMPAIGN_DEFAULT_MAX_ITEMS);
  assert.equal(created.intervalMs, 0);
  assert.equal(created.sessionId, null);
  assert.equal(created.pid, null);
  assert.equal(created.finishedAt, null);

  assert.equal(created.items.length, 2);
  assert.equal(created.items[0].id, "item-1");
  assert.equal(created.items[1].id, "item-2");
  assert.deepEqual(created.items[1].dependsOn, ["item-1"]);
  assert.equal(created.items[0].status, "pending");
  assert.equal(created.items[0].round, 0);
  assert.equal(created.items[0].maxRounds, types.CAMPAIGN_DEFAULT_ITEM_MAX_ROUNDS);
  assert.equal(created.items[0].acceptance, "");
  assert.deepEqual(created.items[0].rounds, []);

  assert.deepEqual(store.getCampaign(created.id, agentDir), created);
  assert.deepEqual(store.listCampaigns(agentDir).map((campaign) => campaign.id), [created.id]);
});

test("落盘是原子写：文件是完整 JSON，目录里没有残留 .tmp", async (t) => {
  const agentDir = await tempDir(t);
  const created = store.createCampaign(validInput(), agentDir);
  const dir = join(agentDir, "campaigns");
  const files = await readdir(dir);

  assert.deepEqual(files.filter((file) => file.endsWith(".tmp")), []);
  assert.deepEqual(files.filter((file) => file.endsWith(".json")), [`${created.id}.json`]);

  const raw = JSON.parse(await readFile(join(dir, `${created.id}.json`), "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.id, created.id);
  assert.equal(raw.objective, validInput().objective);
  assert.equal(raw.items.length, 2);
});

test("createCampaign 结构校验：缺 verify / 无成本闸 / 越界一律拒绝且不落盘", async (t) => {
  const agentDir = await tempDir(t);

  const noVerify = validInput();
  noVerify.items[0].verifyCommand = "  ";
  assertValidationReason(() => store.createCampaign(noVerify, agentDir), "itemVerifyRequired");

  assertValidationReason(() => store.createCampaign(validInput({ maxTotalCostUsd: 0 }), agentDir), "maxTotalCostUsdRequired");
  assertValidationReason(() => store.createCampaign(validInput({ maxItems: 0 }), agentDir), "maxItemsRange");
  assertValidationReason(() => store.createCampaign(validInput({ maxTotalRounds: 0 }), agentDir), "maxTotalRoundsRange");

  const cycle = validInput();
  cycle.items[0].dependsOn = ["item-2"];
  assertValidationReason(() => store.createCampaign(cycle, agentDir), "itemDependsOnCycle");

  assert.deepEqual(store.listCampaigns(agentDir), []);
});

test("坏 JSON 与非法文件名被忽略但不删除", async (t) => {
  const agentDir = await tempDir(t);
  const created = store.createCampaign(validInput(), agentDir);
  const dir = join(agentDir, "campaigns");

  const corruptId = "00000000-0000-4000-8000-000000000000";
  const corruptPath = join(dir, `${corruptId}.json`);
  await writeFile(corruptPath, "{not json", "utf8");
  await writeFile(join(dir, "not-a-uuid.json"), "{}", "utf8");
  await writeFile(join(dir, "notes.txt"), "ignore me", "utf8");

  assert.deepEqual(store.listCampaigns(agentDir).map((campaign) => campaign.id), [created.id]);
  assert.equal(store.getCampaign(corruptId, agentDir), undefined);
  assert.equal(store.getCampaign("../escape", agentDir), undefined);
  assert.equal(store.getCampaign("not-a-uuid", agentDir), undefined);
  // 坏文件保留（更新版本可能理解它）。
  assert.equal(await readFile(corruptPath, "utf8"), "{not json");
});

test("updateCampaign 裁剪轮次、刷新 updatedAt、id/createdAt 不可变", async (t) => {
  const agentDir = await tempDir(t);
  const created = store.createCampaign(validInput(), agentDir);
  const rounds = Array.from({ length: types.CAMPAIGN_MAX_ROUND_RECORDS + 5 }, (_, index) => ({
    round: index + 1,
    at: 1000 + index,
    status: "verify-failed",
    verifyExitCode: 1,
    error: `e${index + 1}`,
  }));

  const updated = store.updateCampaign(created.id, (campaign) => ({
    ...campaign,
    status: "running",
    items: campaign.items.map((item, index) => (index === 0 ? { ...item, rounds } : item)),
  }), agentDir);

  assert.ok(updated);
  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.status, "running");
  assert.equal(updated.items[0].rounds.length, types.CAMPAIGN_MAX_ROUND_RECORDS);
  // 丢最早、留最新。
  assert.equal(updated.items[0].rounds[0].round, 6);
  assert.equal(updated.items[0].rounds.at(-1).round, types.CAMPAIGN_MAX_ROUND_RECORDS + 5);
  assert.ok(updated.updatedAt >= created.updatedAt);

  assert.deepEqual(store.getCampaign(created.id, agentDir), updated);
  assert.equal(store.updateCampaign("00000000-0000-4000-8000-000000000000", (c) => c, agentDir), undefined);
  assert.equal(store.updateCampaign("../escape", (c) => c, agentDir), undefined);
});

test("writeCampaign 拒绝形状不合法的对象（程序错误）", async (t) => {
  const agentDir = await tempDir(t);
  const created = store.createCampaign(validInput(), agentDir);
  const broken = { ...created, objective: 42 };
  assertValidationReason(() => store.writeCampaign(broken, agentDir), "invalidCampaign");
});

test("deleteCampaign 只删合法 uuid，返回是否删到", async (t) => {
  const agentDir = await tempDir(t);
  const created = store.createCampaign(validInput(), agentDir);
  assert.equal(store.deleteCampaign("../escape", agentDir), false);
  assert.equal(store.deleteCampaign("00000000-0000-4000-8000-000000000000", agentDir), false);
  assert.equal(store.deleteCampaign(created.id, agentDir), true);
  assert.equal(store.deleteCampaign(created.id, agentDir), false);
  assert.deepEqual(store.listCampaigns(agentDir), []);
});

test("战役数量上限：达到 CAMPAIGN_MAX_CAMPAIGNS 后拒绝新建，删一个即可再建", async (t) => {
  const agentDir = await tempDir(t);
  const ids = [];
  for (let index = 0; index < types.CAMPAIGN_MAX_CAMPAIGNS; index += 1) {
    ids.push(store.createCampaign(validInput({ objective: `campaign ${index}` }), agentDir).id);
  }
  assert.equal(store.listCampaigns(agentDir).length, types.CAMPAIGN_MAX_CAMPAIGNS);
  assertValidationReason(() => store.createCampaign(validInput(), agentDir), "tooManyCampaigns");

  assert.equal(store.deleteCampaign(ids[0], agentDir), true);
  const again = store.createCampaign(validInput({ objective: "fresh" }), agentDir);
  assert.match(again.id, UUID_RE);
  assert.equal(store.listCampaigns(agentDir).length, types.CAMPAIGN_MAX_CAMPAIGNS);
});

test("listCampaigns 按 createdAt 降序（最新在前）", async (t) => {
  const agentDir = await tempDir(t);
  const first = store.createCampaign(validInput({ objective: "first" }), agentDir);
  store.writeCampaign({ ...first, createdAt: 1 }, agentDir);
  const second = store.createCampaign(validInput({ objective: "second" }), agentDir);
  store.writeCampaign({ ...second, createdAt: 2 }, agentDir);

  assert.deepEqual(
    store.listCampaigns(agentDir).map((campaign) => campaign.objective),
    ["second", "first"],
  );
});
