import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Campaign 纯类型/纯判定层：availableItems 拓扑与 blocked、resume 选 K、
 * 三种硬闸触顶、入参形状校验（含依赖环）。全程不碰 fs。
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const types = await jiti.import("./types.ts");

function makeItem(over = {}) {
  return {
    id: "item-1",
    title: "t",
    instruction: "i",
    acceptance: "",
    verifyCommand: "true",
    dependsOn: [],
    status: "pending",
    round: 0,
    maxRounds: 20,
    costUsd: 0,
    lastError: null,
    rounds: [],
    ...over,
  };
}

function makeCampaign(over = {}) {
  return {
    version: 1,
    id: "11111111-1111-4111-8111-111111111111",
    objective: "把项目推进到可发布",
    cwd: "/tmp/project",
    status: "running",
    items: [],
    currentItemId: null,
    maxTotalRounds: 400,
    maxItems: 40,
    maxTotalCostUsd: 10,
    spentCostUsd: 0,
    totalRounds: 0,
    intervalMs: 0,
    sessionId: null,
    pid: null,
    startedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    finishedAt: null,
    lastError: null,
    ...over,
  };
}

const validInput = () => ({
  objective: "把项目推进到可发布",
  cwd: "/tmp/project",
  maxTotalCostUsd: 5,
  items: [
    { title: "a", instruction: "do a", verifyCommand: "npm test" },
    { title: "b", instruction: "do b", verifyCommand: "npm test", dependsOn: ["item-1"] },
  ],
});

test("availableItems：只返回 pending 且依赖全部 done 的项，保持原顺序", () => {
  const items = [
    makeItem({ id: "item-1" }),
    makeItem({ id: "item-2", dependsOn: ["item-1"] }),
    makeItem({ id: "item-3" }),
  ];
  assert.deepEqual(
    types.availableItems(makeCampaign({ items })).map((item) => item.id),
    ["item-1", "item-3"],
  );

  // item-1 done 后，item-2 解锁；顺序仍是 backlog 顺序。
  const afterDone = items.map((item) => (item.id === "item-1" ? { ...item, status: "done" } : item));
  assert.deepEqual(
    types.availableItems(makeCampaign({ items: afterDone })).map((item) => item.id),
    ["item-2", "item-3"],
  );

  // 依赖缺失 → blocked（保守：不把缺失当已解除）。
  const dangling = [makeItem({ id: "item-1" }), makeItem({ id: "item-2", dependsOn: ["item-9"] })];
  assert.deepEqual(
    types.availableItems(makeCampaign({ items: dangling })).map((item) => item.id),
    ["item-1"],
  );

  // 非 pending（running/verifying/done）一律不算 available。
  const statuses = [
    makeItem({ id: "item-1", status: "running" }),
    makeItem({ id: "item-2", status: "verifying" }),
    makeItem({ id: "item-3", status: "done" }),
  ];
  assert.deepEqual(types.availableItems(makeCampaign({ items: statuses })), []);
});

test("nextResumeItem：跳过 done/skipped，取第一个依赖已满足的未完成项（含 running/failed）", () => {
  const items = [
    makeItem({ id: "item-1", status: "done" }),
    makeItem({ id: "item-2", status: "skipped" }),
    makeItem({ id: "item-3", status: "running" }),
    makeItem({ id: "item-4", status: "pending", dependsOn: ["item-3"] }),
  ];
  assert.equal(types.nextResumeItem(makeCampaign({ items }))?.id, "item-3");

  // 进程重启停在半途：running 项被选回（resume 从第 K 项续）。
  const failedFirst = [
    makeItem({ id: "item-1", status: "failed" }),
    makeItem({ id: "item-2", status: "pending", dependsOn: ["item-1"] }),
  ];
  assert.equal(types.nextResumeItem(makeCampaign({ items: failedFirst }))?.id, "item-1");

  // 全 done/skipped → null。
  const finished = [makeItem({ id: "item-1", status: "done" }), makeItem({ id: "item-2", status: "skipped" })];
  assert.equal(types.nextResumeItem(makeCampaign({ items: finished })), null);

  // 依赖被 skipped（非 done）挡住 → 没有候选，返回 null。
  const blocked = [
    makeItem({ id: "item-1", status: "skipped" }),
    makeItem({ id: "item-2", status: "pending", dependsOn: ["item-1"] }),
  ];
  assert.equal(types.nextResumeItem(makeCampaign({ items: blocked })), null);
});

test("campaignGateExceeded：轮数 / 成本 / 项数三种触顶", () => {
  assert.equal(types.campaignGateExceeded(makeCampaign({ totalRounds: 400, maxTotalRounds: 400 })), "maxTotalRounds");
  assert.equal(
    types.campaignGateExceeded(makeCampaign({ spentCostUsd: 10, maxTotalCostUsd: 10 })),
    "maxTotalCostUsd",
  );
  const items = [makeItem({ id: "item-1" }), makeItem({ id: "item-2" }), makeItem({ id: "item-3" })];
  assert.equal(types.campaignGateExceeded(makeCampaign({ items, maxItems: 2 })), "maxItems");
  // 健康战役不过闸。
  assert.equal(types.campaignGateExceeded(makeCampaign({ items })), null);
  // 恰好在硬顶之下也不触发。
  assert.equal(types.campaignGateExceeded(makeCampaign({ totalRounds: 399, maxTotalRounds: 400 })), null);
});

test("campaignProgress 统计 done/failed/skipped/remaining", () => {
  const items = [
    makeItem({ id: "item-1", status: "done" }),
    makeItem({ id: "item-2", status: "failed" }),
    makeItem({ id: "item-3", status: "skipped" }),
    makeItem({ id: "item-4", status: "pending" }),
  ];
  assert.deepEqual(types.campaignProgress(makeCampaign({ items })), {
    total: 4,
    done: 1,
    failed: 1,
    skipped: 1,
    remaining: 2,
  });
});

test("campaignInputShapeErrors：合法输入零错误", () => {
  assert.deepEqual(types.campaignInputShapeErrors(validInput()), []);
});

test("campaignInputShapeErrors：成本闸必填且 > 0", () => {
  for (const value of [0, -1, Number.NaN, undefined]) {
    assert.ok(
      types.campaignInputShapeErrors({ ...validInput(), maxTotalCostUsd: value }).includes("maxTotalCostUsdRequired"),
      `maxTotalCostUsd=${String(value)} must be rejected`,
    );
  }
});

test("campaignInputShapeErrors：maxItems / maxTotalRounds 越界", () => {
  assert.ok(types.campaignInputShapeErrors({ ...validInput(), maxItems: 0 }).includes("maxItemsRange"));
  assert.ok(
    types.campaignInputShapeErrors({ ...validInput(), maxItems: types.CAMPAIGN_MAX_ITEMS_LIMIT + 1 }).includes("maxItemsRange"),
  );
  assert.ok(types.campaignInputShapeErrors({ ...validInput(), maxTotalRounds: 0 }).includes("maxTotalRoundsRange"));
  assert.ok(
    types.campaignInputShapeErrors({ ...validInput(), maxTotalRounds: 2.5 }).includes("maxTotalRoundsRange"),
  );
});

test("campaignInputShapeErrors：项数超过 maxItems、objective/items 必填", () => {
  const many = {
    ...validInput(),
    maxItems: 1,
    items: [
      { title: "a", instruction: "a", verifyCommand: "true" },
      { title: "b", instruction: "b", verifyCommand: "true" },
    ],
  };
  assert.ok(types.campaignInputShapeErrors(many).includes("itemsOverMaxItems"));
  assert.ok(types.campaignInputShapeErrors({ ...validInput(), objective: "  " }).includes("objectiveRequired"));
  assert.ok(types.campaignInputShapeErrors({ ...validInput(), cwd: "" }).includes("cwdRequired"));
  assert.ok(types.campaignInputShapeErrors({ ...validInput(), items: [] }).includes("itemsRequired"));
});

test("campaignInputShapeErrors：每项 verifyCommand 必填、maxRounds 有界", () => {
  const bad = validInput();
  bad.items[0].verifyCommand = "   ";
  assert.ok(types.campaignInputShapeErrors(bad).includes("itemVerifyRequired"));

  const badRounds = validInput();
  badRounds.items[0].maxRounds = 999;
  assert.ok(types.campaignInputShapeErrors(badRounds).includes("itemMaxRoundsRange"));

  const badTitle = validInput();
  badTitle.items[0].title = "";
  assert.ok(types.campaignInputShapeErrors(badTitle).includes("itemTitleRequired"));
});

test("campaignInputShapeErrors：未知依赖与依赖环", () => {
  const unknown = validInput();
  unknown.items[1].dependsOn = ["item-9"];
  assert.ok(types.campaignInputShapeErrors(unknown).includes("itemDependsOnUnknown"));

  const cycle = {
    ...validInput(),
    items: [
      { title: "a", instruction: "a", verifyCommand: "true", dependsOn: ["item-2"] },
      { title: "b", instruction: "b", verifyCommand: "true", dependsOn: ["item-1"] },
    ],
  };
  assert.ok(types.campaignInputShapeErrors(cycle).includes("itemDependsOnCycle"));

  const self = {
    ...validInput(),
    items: [{ title: "a", instruction: "a", verifyCommand: "true", dependsOn: ["item-1"] }],
  };
  assert.ok(types.campaignInputShapeErrors(self).includes("itemDependsOnCycle"));
});

test("isActiveCampaignStatus / isTerminalCampaignStatus 口径", () => {
  for (const status of ["queued", "running", "verifying", "waiting-provider"]) {
    assert.equal(types.isActiveCampaignStatus(status), true);
    assert.equal(types.isTerminalCampaignStatus(status), false);
  }
  for (const status of ["paused", "succeeded", "failed", "stopped"]) {
    assert.equal(types.isActiveCampaignStatus(status), false);
    assert.equal(types.isTerminalCampaignStatus(status), true);
  }
});
