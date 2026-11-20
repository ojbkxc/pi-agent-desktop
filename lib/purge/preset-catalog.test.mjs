import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// `lib/purge/preset-catalog.ts` 是生成物（scripts/sync-purge-presets.mjs）。
// 这里既验生成物的不变式，也验脚本里那份「--check 的纯函数版本」，两者必须同源。
const rootDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { BUILTIN_PRESETS } = await jiti.import("./preset-catalog.ts");
const sync = await import("../../scripts/sync-purge-presets.mjs");

/** 53 条第三方预设：条数、资产布局、总字节都由生成物自己反推。 */
const EXPECTED_COUNT = 53;

/**
 * 需要来源仓库在位的用例（与真实来源比对）在本机跑，别处跳过——
 * 已提交的 `preset-catalog.ts` + `assets/` 本身才是 CI 的真相。
 */
const sourceDir = sync.resolveSourceDir();
const needsSource = existsSync(sourceDir)
  ? false
  : `来源仓库不在本机（${sourceDir}），设置 PURGE_PRESETS_SOURCE 后重跑`;

const TEMP_DIRS = [];
after(async () => {
  await Promise.all(TEMP_DIRS.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

/** 独立于脚本的排序比较：大小写不敏感 `(vendor, model, id)`，与下游列表顺序一致。 */
function byPosition(a, b) {
  for (const key of ["vendor", "model", "id"]) {
    const left = a[key].toLowerCase();
    const right = b[key].toLowerCase();
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}

const sha256 = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

test("目录不变式：53 条，字段齐全且类型正确", () => {
  assert.equal(BUILTIN_PRESETS.length, EXPECTED_COUNT);

  for (const preset of BUILTIN_PRESETS) {
    const label = preset.id;
    for (const field of ["id", "vendor", "model", "title", "sha256", "body"]) {
      assert.equal(typeof preset[field], "string", `${label}: ${field} 必须是字符串`);
      assert.ok(preset[field].length > 0, `${label}: ${field} 不能为空`);
    }
    assert.equal(typeof preset.bytes, "number", `${label}: bytes 必须是数字`);
    assert.ok(Number.isInteger(preset.bytes) && preset.bytes > 0, `${label}: bytes 必须是正整数`);
    assert.match(preset.sha256, /^[0-9a-f]{64}$/, `${label}: sha256 必须是 64 位小写十六进制`);

    assert.ok(Array.isArray(preset.tags), `${label}: tags 必须是数组`);
    assert.ok(preset.tags.length > 0, `${label}: tags 不能为空数组`);
    for (const tag of preset.tags) {
      assert.equal(typeof tag, "string", `${label}: tag 必须是字符串`);
      assert.ok(tag.trim().length > 0, `${label}: tag 不能是空串`);
    }
    assert.equal(new Set(preset.tags).size, preset.tags.length, `${label}: tags 不能重复`);
    // 整个来源库都是破甲预设，这一条必须都在（见脚本 TAG_RULES 注释）。
    assert.ok(preset.tags.includes("jailbreak"), `${label}: 缺少 jailbreak 标签`);
  }
});

test("id 唯一，且满足 slug 路径段契约（非空 / ≤128 字节 / [a-z0-9-] / 不以 - 首尾）", () => {
  const ids = BUILTIN_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length, `id 有重复：${ids.length - new Set(ids).size} 个`);

  for (const preset of BUILTIN_PRESETS) {
    const { id } = preset;
    assert.match(id, /^[a-z0-9-]+$/, `${id}: 只允许 [a-z0-9-]`);
    assert.ok(!id.startsWith("-") && !id.endsWith("-"), `${id}: 不能以 - 开头或结尾`);
    assert.ok(Buffer.byteLength(id, "utf8") <= 128, `${id}: 超过 128 字节`);
    // id = <vendor>-<model>：厂商一段必须能对上。
    assert.ok(id.startsWith(`${sync.slug(preset.vendor)}-`), `${id}: 前缀必须是厂商 slug`);
  }
});

test("排序单调：按 (vendor, model, id) 大小写不敏感递增", () => {
  for (let i = 1; i < BUILTIN_PRESETS.length; i += 1) {
    const previous = BUILTIN_PRESETS[i - 1];
    const current = BUILTIN_PRESETS[i];
    assert.ok(
      byPosition(previous, current) < 0,
      `第 ${i} 条乱序：${JSON.stringify([previous.vendor, previous.model, previous.id])} 之后是 ${JSON.stringify([
        current.vendor,
        current.model,
        current.id,
      ])}`,
    );
  }
  // 与脚本自己的比较器一致（排序规则只有一份）。
  assert.deepEqual([...BUILTIN_PRESETS].sort(sync.comparePresets), [...BUILTIN_PRESETS]);
});

test("body 非空，bytes 与 UTF-8 长度一致，sha256 可按 body 重算", () => {
  for (const preset of BUILTIN_PRESETS) {
    assert.ok(preset.body.trim().length > 0, `${preset.id}: 正文为空`);
    assert.equal(preset.bytes, Buffer.byteLength(preset.body, "utf8"), `${preset.id}: bytes 与正文不符`);
    assert.equal(preset.sha256, sha256(preset.body), `${preset.id}: sha256 与正文不符`);
    // 规范化只做 CRLF→LF 与去 BOM：落盘正文里不该再有 \r\n 或 BOM。
    assert.ok(!preset.body.includes("\r\n"), `${preset.id}: 正文里还有 CRLF`);
    assert.ok(!preset.body.startsWith("\uFEFF"), `${preset.id}: 正文里还有 BOM`);
  }
});

test("资产快照与目录逐条一致：assets/purge-presets/<vendor>/<id>.md 存在且内容等于 body", async () => {
  for (const preset of BUILTIN_PRESETS) {
    const relativePath = sync.assetRelativePath(preset);
    const onDisk = await readFile(join(rootDir, sync.ASSETS_RELATIVE_DIR, ...relativePath.split("/")), "utf8");
    assert.equal(onDisk.replace(/\r\n/g, "\n"), preset.body, `${relativePath}: 与 body 不一致`);
  }

  // 资产目录里不该有目录模块不认识的残留文件。
  const expected = BUILTIN_PRESETS.map(sync.assetRelativePath).sort();
  const actual = [];
  const vendors = await readdir(join(rootDir, sync.ASSETS_RELATIVE_DIR));
  for (const vendor of vendors) {
    for (const name of await readdir(join(rootDir, sync.ASSETS_RELATIVE_DIR, vendor))) {
      actual.push(`${vendor}/${name}`);
    }
  }
  assert.deepEqual(actual.sort(), expected);
});

test("slug / normalizeBody / deriveTags：纯函数边界", () => {
  assert.equal(sync.slug("0x8D jailbreaks"), "0x8d-jailbreaks");
  assert.equal(sync.slug("Muse spark 1.3"), "muse-spark-1-3");
  assert.equal(sync.slug("  --A_b!!!  "), "a-b");
  assert.equal(sync.slug("mistral-small-4 (duck.ai)"), "mistral-small-4-duck-ai");
  assert.equal(sync.slug(""), "");

  // 空 id 必须拒绝，而不是产出 `-` 之类的坏路径段。
  assert.throws(() => sync.assertPresetId(""), /id 为空/);
  assert.throws(() => sync.assertPresetId("-abc"), /首尾有 -/);
  assert.throws(() => sync.assertPresetId("abc-"), /首尾有 -/);
  assert.throws(() => sync.assertPresetId("A-bc"), /非法字符/);
  assert.throws(() => sync.assertPresetId("a".repeat(129)), /128 字节/);
  assert.equal(sync.assertPresetId("a".repeat(128)), "a".repeat(128));

  // 只折行尾、只丢 BOM，其余字节原样（独占的 \r 不是 CRLF，不动）。
  assert.equal(sync.normalizeBody("\uFEFFa\r\nb\rc\n"), "a\nb\rc\n");
  assert.equal(sync.normalizeBody("\r\n\r\n"), "\n\n");
  assert.equal(sync.normalizeBody("\uFEFF"), "");

  assert.deepEqual(sync.deriveTags("Stealth Models", "spacebunny-agents", ".md"), [
    "jailbreak",
    "agents-md",
    "stealth",
  ]);
  assert.deepEqual(sync.deriveTags("xAI", "grok-config", ".txt"), ["jailbreak", "config"]);
  // 判不出来就只留 jailbreak，不编造。
  assert.deepEqual(sync.deriveTags("Anthropic", "opus v1", ".md"), ["jailbreak"]);
});

test("来源目录异常：非 UTF-8 必须报错，空正文跳过，根目录文件不算预设", async () => {
  const dir = await tempDir("purge-presets-src-");
  await mkdir(join(dir, "Only Vendor"), { recursive: true });
  await writeFile(join(dir, "Only Vendor", "ok.md"), "# ok\r\nbody\r\n", "utf8");
  await writeFile(join(dir, "Only Vendor", "empty.md"), "\r\n", "utf8");
  await writeFile(join(dir, "Only Vendor", "skip.json"), "{}", "utf8");
  await writeFile(join(dir, "README.md"), "# 根目录说明\n", "utf8");

  const result = await sync.collectSourcePresets({ sourceDir: dir });
  assert.equal(result.presets.length, 1, "只有 ok.md 是预设");
  assert.equal(result.presets[0].id, "only-vendor-ok");
  assert.equal(result.presets[0].body, "# ok\nbody\n");
  assert.deepEqual(result.skipped.map((entry) => entry.path), ["Only Vendor/empty.md"]);

  const broken = await tempDir("purge-presets-broken-");
  await mkdir(join(broken, "V"), { recursive: true });
  await writeFile(join(broken, "V", "latin1.md"), Buffer.from([0x4f, 0x6b, 0x20, 0xe9, 0x0a]));
  await assert.rejects(() => sync.collectSourcePresets({ sourceDir: broken }), /不是合法的 UTF-8：V\/latin1\.md/);
});

test("来源目录异常：折不出 slug 或两个文件折出同一个 id 时立即报错，不静默改名", async () => {
  const dup = await tempDir("purge-presets-dup-");
  await mkdir(join(dup, "Vendor"), { recursive: true });
  await writeFile(join(dup, "Vendor", "Foo Bar.md"), "one\n", "utf8");
  await writeFile(join(dup, "Vendor", "foo-bar.md"), "two\n", "utf8");
  await assert.rejects(() => sync.collectSourcePresets({ sourceDir: dup }), /id 重复：vendor-foo-bar/);

  // 全 CJK 文件名折不出 ASCII slug：报错要求上游改名，而不是硬塞一个兜底 id。
  const cjk = await tempDir("purge-presets-cjk-");
  await mkdir(join(cjk, "厂商"), { recursive: true });
  await writeFile(join(cjk, "厂商", "破甲.md"), "正文\n", "utf8");
  await assert.rejects(() => sync.collectSourcePresets({ sourceDir: cjk }), /无法折出 slug/);
});

test("verifySync：磁盘与重新生成的结果一致", { skip: needsSource }, async () => {
  const result = await sync.verifySync();
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.equal(result.count, EXPECTED_COUNT);
  assert.equal(result.totalBytes, BUILTIN_PRESETS.reduce((sum, preset) => sum + preset.bytes, 0));
  assert.equal(result.vendorCount, new Set(BUILTIN_PRESETS.map((preset) => preset.vendor)).size);
});

test("verifySync 是 --check 的可测版本：篡改资产 / 目录模块 / 残留文件都能报出来", { skip: needsSource }, async () => {
  const root = await tempDir("purge-presets-root-");
  const written = await sync.writeSync({ root });
  assert.equal(written.presets.length, EXPECTED_COUNT);

  const clean = await sync.verifySync({ root });
  assert.equal(clean.ok, true, clean.problems.join("\n"));

  // 1. 目录模块被手改一个字符。
  const catalogPath = join(root, sync.CATALOG_RELATIVE_PATH);
  const catalogText = await readFile(catalogPath, "utf8");
  await writeFile(catalogPath, catalogText.replace("readonly id: string;", "readonly id:  string;"), "utf8");
  const tamperedCatalog = await sync.verifySync({ root });
  assert.equal(tamperedCatalog.ok, false);
  assert.ok(
    tamperedCatalog.problems.some((line) => line.includes(sync.CATALOG_RELATIVE_PATH)),
    "应报目录模块不一致",
  );
  await writeFile(catalogPath, catalogText, "utf8");

  // 2. 资产文件被改正文。
  const assetRel = sync.assetRelativePath(written.presets[0]);
  const assetPath = join(root, sync.ASSETS_RELATIVE_DIR, ...assetRel.split("/"));
  const original = await readFile(assetPath, "utf8");
  await writeFile(assetPath, `${original}\n多出来的一行\n`, "utf8");
  const tamperedAsset = await sync.verifySync({ root });
  assert.equal(tamperedAsset.ok, false);
  assert.ok(
    tamperedAsset.problems.some((line) => line.includes("资产内容不一致")),
    "应报资产内容不一致",
  );
  await writeFile(assetPath, original, "utf8");

  // 3. 全量重建会清空残留：多出来的文件必须报错，而不是被忽略。
  const strayPath = join(root, sync.ASSETS_RELATIVE_DIR, "stray", "left-over.md");
  await mkdir(dirname(strayPath), { recursive: true });
  await writeFile(strayPath, "残留\n", "utf8");
  const stray = await sync.verifySync({ root });
  assert.equal(stray.ok, false);
  assert.ok(
    stray.problems.some((line) => line.includes("多余资产文件")),
    "应报多余资产文件",
  );

  // 重建后恢复干净（幂等：同样的来源逐字节相同）。
  await sync.writeSync({ root });
  assert.equal((await sync.verifySync({ root })).ok, true);
});

test("CLI：--check 打印「一致：53 条，N 字节」并以 0 退出", { skip: needsSource }, () => {
  const result = spawnSync(process.execPath, [join(rootDir, "scripts", "sync-purge-presets.mjs"), "--check"], {
    encoding: "utf8",
    cwd: rootDir,
  });
  assert.equal(result.status, 0, result.stderr);
  const totalBytes = BUILTIN_PRESETS.reduce((sum, preset) => sum + preset.bytes, 0);
  assert.match(result.stdout, new RegExp(`^一致：${EXPECTED_COUNT} 条，${totalBytes} 字节`, "m"));
  // 空正文的来源文件被跳过，但必须点名，不能静默。
  assert.match(result.stderr, /跳过：Alibaba\/qwen-preferences\.md/);
});

test("CLI：不认识的参数以 2 退出且不写盘", () => {
  const result = spawnSync(process.execPath, [join(rootDir, "scripts", "sync-purge-presets.mjs"), "--nope"], {
    encoding: "utf8",
    cwd: rootDir,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /未知参数：--nope/);
});
