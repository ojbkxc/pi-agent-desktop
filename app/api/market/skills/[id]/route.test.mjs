import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";

/**
 * 详情路由 O1 修复的回归测试。
 *
 * 现象：clawhub:self-improving-agent 在快照里是 flagged，但详情直取上游时被上游的 clean 覆盖，
 * 变成 benign，于是「列表标风险、详情说安全」。修法：路由在 TTL 缓存之后用快照的编辑性字段
 * 覆盖 provider 详情（见 lib/skill-market/catalog.ts 的 withCatalogMetadata）。
 *
 * 这里用本地 HTTP 桩冒充 clawhub：上游一律回 clean（→ benign），断言路由最终仍给 flagged，
 * 并且 provider 的正文/版本/文件清单/扫描明细都保留。
 */

const root = await mkdtemp(join(tmpdir(), "pi-market-detail-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousBase = process.env.PI_MARKET_BASE_CLAWHUB;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

/** 上游桩：任何 slug 的详情都回 clean（benign）。 */
const upstream = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const versionMatch = path.match(/^\/api\/v1\/skills\/([^/]+)\/versions\/[^/]+$/);
  const detailMatch = path.match(/^\/api\/v1\/skills\/([^/]+)$/);
  const send = (payload) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };
  if (versionMatch) {
    send({
      version: {
        version: "4.0.2",
        license: "MIT-0",
        files: [{ path: "SKILL.md", size: 12, sha256: "" }],
        security: { status: "clean" },
      },
    });
    return;
  }
  if (detailMatch) {
    const slug = decodeURIComponent(detailMatch[1]);
    send({
      skill: {
        slug,
        displayName: "Self improving agent",
        summary: "Upstream English summary",
        description: "---\nname: x\ndescription: y\n---\nBody text",
        stats: { downloads: 1 },
        latestVersion: { version: "4.0.2" },
      },
      owner: { handle: "pskoett", displayName: "PS" },
      latestVersion: { version: "4.0.2", license: "MIT-0", changelog: "release notes", createdAt: 123 },
    });
    return;
  }
  response.writeHead(404).end();
});

let base;
let GET;

before(async () => {
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${upstream.address().port}`;
  process.env.PI_MARKET_BASE_CLAWHUB = base;
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
  ({ GET } = await jiti.import("./route.ts"));
});

after(async () => {
  await new Promise((resolve) => upstream.close(resolve));
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousBase === undefined) delete process.env.PI_MARKET_BASE_CLAWHUB;
  else process.env.PI_MARKET_BASE_CLAWHUB = previousBase;
  await rm(root, { recursive: true, force: true });
});

function detailRequest(id, owner) {
  const query = owner ? `?owner=${encodeURIComponent(owner)}` : "";
  return GET(
    new Request(`http://localhost/api/market/skills/${encodeURIComponent(id)}${query}`),
    { params: Promise.resolve({ id }) },
  );
}

test("catalog 内 flagged 技能：详情回填快照结论，securityNote 非空，同时保留 provider 实时字段", async () => {
  const response = await detailRequest("clawhub:self-improving-agent", "pskoett");
  assert.equal(response.status, 200);
  const { skill } = await response.json();

  // 快照的审核口径覆盖上游的 benign。
  assert.equal(skill.securityStatus, "flagged");
  assert.ok(skill.securityNote && skill.securityNote.trim().length > 0);
  assert.equal(skill.curated, true);
  assert.equal(skill.category, "agent");
  // 快照的中文摘要 + 英文摘要回填。
  assert.match(skill.summary, /自我改进|命令失败/);
  assert.ok(skill.summaryEn && skill.summaryEn.length > 0);

  // provider 的实时字段原样保留。
  assert.equal(skill.description.trim(), "Body text");
  assert.equal(skill.version, "4.0.2");
  assert.equal(skill.license, "MIT-0");
  assert.equal(skill.totalSize, 12);
  assert.equal(skill.files.length, 1);
  assert.equal(skill.changelog.text, "release notes");
  assert.ok(Array.isArray(skill.securityReports) && skill.securityReports.length > 0, "上游扫描明细保留");
});

test("缓存读取之后才覆盖：第二次（命中缓存）仍是 flagged", async () => {
  await detailRequest("clawhub:self-improving-agent", "pskoett");
  const second = await detailRequest("clawhub:self-improving-agent", "pskoett");
  const { skill } = await second.json();
  assert.equal(skill.securityStatus, "flagged");
  assert.ok(skill.securityNote);
});

test("非 catalog 技能：详情仍按上游（不冒领精选结论）", async () => {
  const response = await detailRequest("clawhub:not-a-curated-skill", "pskoett");
  assert.equal(response.status, 200);
  const { skill } = await response.json();
  assert.equal(skill.securityStatus, "benign", "上游 clean → benign，未被快照覆盖");
  assert.equal(skill.securityNote, undefined);
  assert.equal(skill.curated, undefined);
});

test("owner 与目录不一致：不套用精选结论", async () => {
  // clawhub 的 slug 跨 owner 重复，另一位作者的同名技能不是同一条精选。
  await detailRequest("clawhub:self-improving-agent", "someone-else");
  const response = await detailRequest("clawhub:self-improving-agent", "someone-else");
  const { skill } = await response.json();
  assert.equal(skill.securityStatus, "benign");
  assert.equal(skill.curated, undefined);
});
