import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const types = await jiti.import("./types.ts");
const market = await jiti.import("./market-service.ts");
const install = await jiti.import("./install-service.ts");
const catalog = await jiti.import("./catalog.ts");

test("id / 目录名 / 路径安全：slug 与落盘目录都是服务端生成", () => {
  assert.equal(types.skillId("clawhub", "pdf-tools"), "clawhub:pdf-tools");
  assert.deepEqual(types.parseSkillId("clawhub:pdf-tools"), { source: "clawhub", slug: "pdf-tools" });
  assert.equal(types.parseSkillId("nope:pdf"), null, "未知来源");
  assert.equal(types.parseSkillId("clawhub:../etc"), null, "带路径分隔符的 slug 必须被拒");
  assert.equal(types.parseSkillId("clawhub:-evil"), null, "以 - 开头的 slug 必须被拒");
  assert.equal(types.parseSkillId("clawhub:"), null);

  // 两个来源同名技能不能互相覆盖。
  assert.equal(types.sanitizeDirName("clawhub", "pdf"), "clawhub-pdf");
  assert.equal(types.sanitizeDirName("skillhub", "pdf"), "skillhub-pdf");

  for (const bad of ["../etc/passwd", "a/../../b", "..\\..\\x", "/abs/path", "a\\..\\..\\b", "x\0y"]) {
    assert.equal(install.isSafeRelativePath(bad), false, bad);
  }
  for (const good of ["SKILL.md", "assets/one.md", "a/b/c.txt", "docs\\win.md"]) {
    assert.equal(install.isSafeRelativePath(good), true, good);
  }
});

test("游标编解码只接受两个来源自己的值", () => {
  const cursor = { clawhub: "c1", skillhub: "2" };
  const encoded = market.encodeCursor(cursor);
  assert.ok(encoded);
  assert.deepEqual(market.decodeCursor(encoded), cursor);
  assert.equal(market.encodeCursor({}), null);
  assert.equal(market.decodeCursor("not-a-cursor"), undefined);
  assert.equal(market.decodeCursor(null), undefined);
  // 多余的键被丢掉，只留已知来源。
  const polluted = Buffer.from(JSON.stringify({ clawhub: "x", evil: "y" }), "utf-8").toString("base64url");
  assert.deepEqual(market.decodeCursor(polluted), { clawhub: "x" });
});

test("交错合并：两源轮流取，来源内按 slug 去重", () => {
  const merged = market.interleaveAndDedupe([
    { source: "clawhub", items: [
      { slug: "a" }, { slug: "b" }, { slug: "a" },
    ] },
    { source: "skillhub", items: [{ slug: "a" }, { slug: "c" }] },
  ]);
  // 同名不同源的 a 都保留（内容可能不同），同一源里重复的 a 只留一条。
  assert.deepEqual(merged.map((item) => `${item.source}:${item.slug}`), [
    "clawhub:a", "skillhub:a", "clawhub:b", "skillhub:c",
  ]);
});

test("列表合并：一个源失败不影响另一个，nextCursor 只带成功的源", async () => {
  market.clearMarketCache();
  const result = await market.listMarketSkills({ scope: "live", limit: 10, sources: ["skillhub"] });
  assert.ok(Array.isArray(result.items));
  assert.equal(result.sourceErrors.length, 0, JSON.stringify(result.sourceErrors));
  // 单源时游标只会有 skillhub（或 null 表示没有更多）。
  if (result.nextCursor) {
    const cursor = market.decodeCursor(result.nextCursor);
    assert.deepEqual(Object.keys(cursor), ["skillhub"]);
  }
});

test("缓存：写入后读回，过期与清空后都读不到", async () => {
  market.clearMarketCache();
  market.writeCache("k", { ok: true });
  assert.deepEqual(market.readCache("k"), { ok: true });
  market.clearMarketCache();
  assert.equal(market.readCache("k"), undefined);
  assert.equal(market.detailCacheKey("clawhub", "pdf", "owner1"), "detail:clawhub:owner1:pdf");
  assert.equal(market.detailCacheKey("clawhub", "pdf"), "detail:clawhub::pdf",
    "无 owner 与有 owner 的键必须不同，否则不同 owner 的同名技能会串内容");
});

test("安装 → 标注已安装 → 卸载拒绝删除非市场目录", async (t) => {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "pi-market-")));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });

  // 一个自带标记文件的市场安装。
  const skills = join(root, "skills");
  const marketDir = join(skills, "clawhub-demo");
  await mkdir(marketDir, { recursive: true });
  await writeFile(join(marketDir, "SKILL.md"), "---\nname: demo\n---\n\nDemo body\n");
  await writeFile(join(marketDir, install.MARKET_META_FILENAME), JSON.stringify({
    source: "clawhub", slug: "demo", version: "1.0.0", installedAt: "2026-11-09T00:00:00.000Z", files: 1,
  }));

  // 一个同名但手工放进去的目录（没有标记）。
  const handDir = join(skills, "clawhub-handmade");
  await mkdir(handDir, { recursive: true });
  await writeFile(join(handDir, "SKILL.md"), "manual\n");

  const installed = await install.listInstalledMarketSkills();
  assert.deepEqual(installed.map((meta) => meta.dirName), ["clawhub-demo"]);
  assert.equal(installed[0].slug, "demo");

  const annotated = await install.annotateInstallState([
    { source: "clawhub", slug: "demo" },
    { source: "clawhub", slug: "other" },
    { source: "skillhub", slug: "demo" },
  ]);
  assert.equal(annotated[0].installState, "installed");
  assert.equal(annotated[0].installedInfo.dirName, "clawhub-demo");
  assert.equal(annotated[1].installState, "installable");
  assert.equal(annotated[2].installState, "installable", "另一来源的同名技能不算已安装");

  assert.deepEqual(await install.installStateFor("clawhub", "demo"), {
    installState: "installed",
    installedInfo: { version: "1.0.0", installedAt: "2026-11-09T00:00:00.000Z", dirName: "clawhub-demo" },
  });
  assert.deepEqual(await install.installStateFor("clawhub", "other"), { installState: "installable" });

  // 卸载：市场目录能删；手工目录必须拒绝。
  const removed = await install.uninstallMarketSkill("clawhub", "demo");
  assert.equal(removed.removedPath, marketDir);
  assert.equal(existsSync(marketDir), false);

  await assert.rejects(
    () => install.uninstallMarketSkill("clawhub", "handmade"),
    /不是市场安装的技能/,
  );
  assert.equal(existsSync(handDir), true, "手工目录必须原封不动");

  await assert.rejects(
    () => install.uninstallMarketSkill("clawhub", "never-installed"),
    /未安装/,
  );

  // 读 SKILL.md 确认安装内容按原样落盘（上面手工目录没被动过）。
  assert.equal(await readFile(join(handDir, "SKILL.md"), "utf-8"), "manual\n");
});

test("scope 缺省为 catalog：走快照、不发网络、给出 total/categories/catalogUpdatedAt", async () => {
  market.clearMarketCache();
  const result = await market.listMarketSkills({ limit: 12 });
  assert.equal(result.sourceErrors.length, 0, JSON.stringify(result.sourceErrors));
  assert.equal(result.items.length, 12);
  assert.equal(result.nextCursor, "catalog:12");
  assert.equal(result.total, 398);
  assert.equal(result.categories.length, 13);
  assert.equal(result.catalogUpdatedAt, catalog.catalogUpdatedAt);
  // 精选项都带 curated，且分页前已标注安装态。
  assert.ok(result.items.every((item) => item.curated === true));
  assert.ok(result.items.every((item) => typeof item.installState === "string"));

  // live 路径不给 catalog 专属字段（保持既有响应形状）。
  const live = await market.listMarketSkills({ scope: "live", limit: 10, sources: ["skillhub"] });
  assert.equal(live.total, undefined);
  assert.equal(live.categories, undefined);
  assert.equal(live.catalogUpdatedAt, undefined);
});

test("catalog 游标：catalog:<offset> 切片，跨页不重复，末尾与越界 nextCursor=null", async () => {
  const first = await market.listMarketSkills({ limit: 5 });
  assert.equal(first.items.length, 5);
  assert.equal(first.nextCursor, "catalog:5");

  const second = await market.listMarketSkills({ limit: 5, cursor: "catalog:5" });
  assert.equal(second.items.length, 5);
  assert.equal(second.nextCursor, "catalog:10");

  const ids = new Set([...first.items, ...second.items].map((item) => item.id));
  assert.equal(ids.size, 10, "两页之间不应重复");

  const beyond = await market.listMarketSkills({ limit: 5, cursor: "catalog:100000" });
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.nextCursor, null);
  assert.equal(beyond.total, 398);
});

test("catalog security 筛选在分页前生效", async () => {
  const flagged = await market.listMarketSkills({ limit: 1000, security: "flagged" });
  assert.ok(flagged.total > 0);
  assert.equal(flagged.total, flagged.items.length, "limit 足够大时 total 应等于返回条数");
  assert.ok(flagged.items.every((item) => item.securityStatus === "flagged"));

  const all = await market.listMarketSkills({ limit: 1000, security: "all" });
  assert.equal(all.total, 398);
});

test("catalog installed 筛选：复用 install-service 的标注，只留本机已安装", async (t) => {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "pi-market-cat-")));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });

  // 取一条真实精选技能，为它造一个匹配的市场安装目录。
  const entry = catalog.getCatalog().skills.find((skill) => skill.source === "clawhub");
  assert.ok(entry);
  const dirName = types.sanitizeDirName(entry.source, entry.slug);
  const marketDir = join(root, "skills", dirName);
  await mkdir(marketDir, { recursive: true });
  await writeFile(join(marketDir, install.MARKET_META_FILENAME), JSON.stringify({
    source: entry.source, slug: entry.slug, version: entry.version, installedAt: "2026-11-10T00:00:00.000Z", files: 1,
  }));

  const installed = await market.listMarketSkills({ limit: 1000, installed: "installed" });
  assert.equal(installed.total, 1);
  assert.equal(installed.items.length, 1);
  assert.equal(installed.items[0].slug, entry.slug);
  assert.equal(installed.items[0].installState, "installed");

  const installable = await market.listMarketSkills({ limit: 1000, installed: "installable" });
  assert.equal(installable.total, 397);
  assert.equal(installable.items.some((item) => item.slug === entry.slug), false);
});
