import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { fixtureDir } from "../../../scripts/test-platform.mjs";

/**
 * POST/GET /api/campaigns + /api/campaigns/[id]。
 *
 * 每个用例跑在临时 PI_CODING_AGENT_DIR 上，绝不碰真实 ~/.pi/agent。创建闸里的
 * git 检查对真实目录跑 `git rev-parse`（所以成功用例用一个真的 git 仓，非 git 用例
 * 用一个**不在任何 git 工作树内**的临时目录）；审批档从 `<agentDir>/pi-web/settings.json`
 * 读到 `all`。后台驱动由 PI_WEB_DISABLE_CAMPAIGN_DRIVER=1 关成 no-op。
 */

const root = await fixtureDir("pi-web-campaign-route-");
const agentDir = join(root, "agent");
const gitProject = join(root, "gitproject");
const nonGitProject = await mkdtemp(join(tmpdir(), "pi-web-campaign-nongit-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousDriver = process.env.PI_WEB_DISABLE_CAMPAIGN_DRIVER;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_WEB_DISABLE_CAMPAIGN_DRIVER = "1";

await mkdir(join(agentDir, "pi-web"), { recursive: true });
// 最低审批档 dangerous：写 all（更强）保证成功用例过审批闸。
await writeFile(join(agentDir, "pi-web", "settings.json"), JSON.stringify({ toolApprovalMode: "all" }), "utf8");
await mkdir(gitProject, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: gitProject, windowsHide: true });

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousDriver === undefined) delete process.env.PI_WEB_DISABLE_CAMPAIGN_DRIVER;
  else process.env.PI_WEB_DISABLE_CAMPAIGN_DRIVER = previousDriver;
  await rm(root, { recursive: true, force: true });
  await rm(nonGitProject, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const listRoute = await jiti.import("./route.ts");
const itemRoute = await jiti.import("./[id]/route.ts");
const store = await jiti.import("../../../lib/campaign/store.ts");

function request(path, init = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { host: "localhost", ...init.headers },
  });
}

function postJson(path, body) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validInput(overrides = {}) {
  return {
    objective: "把计费模块第一版做出来",
    cwd: gitProject,
    maxTotalCostUsd: 25,
    items: [
      { title: "建模型", instruction: "定义 Invoice/Payment 模型", verifyCommand: "npm test -- models" },
      { title: "接支付", instruction: "接支付网关", verifyCommand: "npm test -- payments", dependsOn: ["item-1"] },
    ],
    ...overrides,
  };
}

beforeEach(async () => {
  await rm(join(agentDir, "campaigns"), { recursive: true, force: true });
});

test("POST rejects a campaign without a cost ceiling", async () => {
  const withoutCost = validInput();
  delete withoutCost.maxTotalCostUsd;
  const response = await listRoute.POST(postJson("/api/campaigns", withoutCost));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "validation");
  assert.equal(body.key, "campaign.error.maxTotalCostUsdRequired");
});

test("POST rejects a non-git working directory", async () => {
  const response = await listRoute.POST(postJson("/api/campaigns", validInput({ cwd: nonGitProject })));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.key, "campaign.error.cwdNotGit");
});

test("POST rejects out-of-range limits and bad dependency graphs", async () => {
  const cases = [
    [validInput({ maxItems: 999999 }), "campaign.error.maxItemsRange"],
    [validInput({ maxTotalRounds: 0 }), "campaign.error.maxTotalRoundsRange"],
    [validInput({ items: [{ title: "x", instruction: "y", verifyCommand: "true", dependsOn: ["item-9"] }] }), "campaign.error.itemDependsOnUnknown"],
    [
      validInput({
        items: [
          { title: "a", instruction: "a", verifyCommand: "true", dependsOn: ["item-2"] },
          { title: "b", instruction: "b", verifyCommand: "true", dependsOn: ["item-1"] },
        ],
      }),
      "campaign.error.itemDependsOnCycle",
    ],
  ];
  for (const [input, key] of cases) {
    const response = await listRoute.POST(postJson("/api/campaigns", input));
    assert.equal(response.status, 400, key);
    assert.equal((await response.json()).key, key);
  }
});

test("POST requires a JSON content type", async () => {
  const response = await listRoute.POST(request("/api/campaigns", { method: "POST", body: "objective=x" }));
  assert.equal(response.status, 415);
});

test("POST creates a queued campaign and writes it to disk", async () => {
  const response = await listRoute.POST(postJson("/api/campaigns", validInput()));
  assert.equal(response.status, 201);
  const { campaign } = await response.json();
  assert.equal(campaign.status, "queued");
  assert.equal(campaign.maxTotalCostUsd, 25);
  assert.equal(campaign.items.length, 2);
  assert.equal(campaign.items[0].id, "item-1");
  assert.equal(campaign.items[1].dependsOn[0], "item-1");

  const onDisk = JSON.parse(await readFile(join(agentDir, "campaigns", `${campaign.id}.json`), "utf8"));
  assert.equal(onDisk.objective, "把计费模块第一版做出来");
});

test("GET lists campaigns newest first", async () => {
  const first = (await (await listRoute.POST(postJson("/api/campaigns", validInput({ objective: "one" })))).json()).campaign;
  const second = (await (await listRoute.POST(postJson("/api/campaigns", validInput({ objective: "two" })))).json()).campaign;
  store.updateCampaign(first.id, (current) => ({ ...current, createdAt: current.createdAt - 10 }), agentDir);

  const body = await (await listRoute.GET()).json();
  assert.deepEqual(body.campaigns.map((campaign) => campaign.id), [second.id, first.id]);
});

test("[id] GET 404s for unknown and invalid ids", async () => {
  const unknown = await itemRoute.GET(request("/api/campaigns/x"), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000001" }) });
  assert.equal(unknown.status, 404);
  const invalid = await itemRoute.GET(request("/api/campaigns/x"), { params: Promise.resolve({ id: "../escape" }) });
  assert.equal(invalid.status, 404);
});

test("[id] stop → stopped, resume leaves the terminal state, delete removes", async () => {
  const created = (await (await listRoute.POST(postJson("/api/campaigns", validInput()))).json()).campaign;
  const params = { params: Promise.resolve({ id: created.id }) };

  const stopped = await (await itemRoute.POST(postJson(`/api/campaigns/${created.id}`, { action: "stop" }), params)).json();
  assert.equal(stopped.campaign.status, "stopped");

  const resumed = await itemRoute.POST(postJson(`/api/campaigns/${created.id}`, { action: "resume" }), params);
  assert.equal(resumed.status, 200);
  const resumedBody = await resumed.json();
  assert.notEqual(resumedBody.campaign.status, "stopped");

  const removed = await itemRoute.DELETE(request(`/api/campaigns/${created.id}`, { method: "DELETE" }), params);
  assert.equal(removed.status, 200);
  assert.equal(store.getCampaign(created.id, agentDir), undefined);
});

test("[id] stop/pause of a finished campaign is refused, unknown action is rejected", async () => {
  const created = (await (await listRoute.POST(postJson("/api/campaigns", validInput()))).json()).campaign;
  const params = { params: Promise.resolve({ id: created.id }) };
  store.updateCampaign(created.id, (current) => ({ ...current, status: "succeeded" }), agentDir);

  const refused = await itemRoute.POST(postJson(`/api/campaigns/${created.id}`, { action: "stop" }), params);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).key, "campaign.error.alreadyFinished");

  const badAction = await itemRoute.POST(postJson(`/api/campaigns/${created.id}`, { action: "explode" }), params);
  assert.equal(badAction.status, 400);
  assert.equal((await badAction.json()).key, "campaign.error.unknownAction");
});
