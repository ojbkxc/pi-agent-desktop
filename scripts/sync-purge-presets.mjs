#!/usr/bin/env node
/**
 * 破甲预设数据流水线 — 把 `jailbreaks` 仓库的第三方破甲 prompt 原文数据化成本仓库的
 * 内联字符串常量模块 `lib/purge/preset-catalog.ts`，同时把规范化后的原文落到
 * `assets/purge-presets/<vendor>/<id>.md`，方便人工比对与 git diff。
 *
 * 生成： node scripts/sync-purge-presets.mjs
 * 校验： node scripts/sync-purge-presets.mjs --check   （幂等门禁：一致 exit 0，不一致 exit 1）
 * 来源： 脚本同级目录推导（默认 `../jailbreaks`，即 pi-agent-desktop 的兄弟仓库），
 *        可用环境变量 `PURGE_PRESETS_SOURCE` 指向任意副本。
 *
 * 规则（生成物头注释会指回本脚本；改规则就要重新生成）：
 *  - 只做传输层规范化：丢 UTF-8 BOM、CRLF → LF。正文既不删改、也不过滤、不截断。
 *  - 非 UTF-8 直接报错退出（绝不猜测编码——猜错会把乱码写进产品）。
 *  - 正文全是空白（上游本身就是空文件）不算预设：跳过并在 stderr 点名。当前唯一
 *    例子是 `Alibaba/qwen-preferences.md`，上游就是 2 字节的 CRLF，没有任何正文。
 *  - id = `<vendor>-<model>`，全小写、非 `[a-z0-9]` 折叠为 `-`、去首尾 `-`；
 *    排序 `(vendor, model, id)` 大小写不敏感（与 API 列表顺序、控制台渲染顺序一致）；
 *    id 重复即报错退出，绝不静默改名。
 *  - 产物无时间戳、无随机：同样的来源必然生成逐字节相同的文件，`--check` 才有意义。
 *
 * `--check` 读盘时会先把 CRLF 折成 LF 再比较：仓库开着 `core.autocrlf=true`，
 * 全新 Windows 检出的工作区里这些文件是 CRLF。行尾不是内容，内容不一致照样报错。
 *
 * 本脚本导出的纯函数（`slug` / `normalizeBody` / `deriveTags` / `renderCatalogModule`
 * / `planSync` / `verifySync`）就是 `--check` 的可测版本，测试在
 * `lib/purge/preset-catalog.test.mjs`。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 生成物：内联字符串常量模块（运行时不读盘）。 */
export const CATALOG_RELATIVE_PATH = "lib/purge/preset-catalog.ts";
/** 原文快照目录（全量重建：先清空再写）。 */
export const ASSETS_RELATIVE_DIR = "assets/purge-presets";

/** 只有这两个扩展名的文件才是预设正文。 */
const SOURCE_EXTENSIONS = new Set([".md", ".txt"]);

/** `--check` 通过时打印的那一行（测试按它断言）。 */
export const CONSISTENT_PREFIX = "一致：";

export const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** 默认来源：pi-agent-desktop 的兄弟仓库 `jailbreaks`。 */
export const DEFAULT_SOURCE_DIR = resolve(rootDir, "..", "jailbreaks");

export function resolveSourceDir(env = process.env) {
  const override = env.PURGE_PRESETS_SOURCE?.trim();
  return override ? resolve(override) : DEFAULT_SOURCE_DIR;
}

/**
 * slug 折叠：小写、非 `[a-z0-9]` 折成 `-`、去首尾 `-`、连续 `-` 合并。
 * `0x8D jailbreaks` → `0x8d-jailbreaks`；`Muse spark 1.3` → `muse-spark-1-3`。
 */
export function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * 标签推导：只认**文件名/路径里能稳当判定**的词，判不出来就不加，绝不编造。
 *
 * `jailbreak` 固定带：来源库整体就是破甲 prompt 集合（jailbreaks 仓库 README 的
 * 定位），路径里的 `jailbreaks` 也是可判定依据。其余按 `vendor/model` 字面匹配。
 */
const TAG_RULES = [
  ["jailbreak", (token) => /jailbreak|jaibreak/i.test(token)],
  ["agents-md", (token) => /(^|[-_ ])agents(\.md)?$|agents-md$/i.test(token)],
  ["system-prompt", (token) => /system[-_ ]?prompt/i.test(token)],
  ["persona", (token) => /persona/i.test(token)],
  ["config", (token, extension) => /config/i.test(token) || extension === ".txt"],
  ["opencode", (token) => /opencode/i.test(token)],
  ["stealth", (token) => /stealth/i.test(token)],
  ["ollama", (token) => /ollama|modelfile/i.test(token)],
];

export function deriveTags(vendor, model, extension = "") {
  const token = `${vendor}/${model}`;
  const tags = [];
  for (const [tag, match] of TAG_RULES) {
    if (match(token, extension)) tags.push(tag);
  }
  // 整库定位（见上方注释）：每条都是破甲预设，因此一定有这一条。
  if (!tags.includes("jailbreak")) tags.unshift("jailbreak");
  return tags;
}

/** 传输层规范化：丢 BOM、CRLF → LF。正文其余部分原样保留。 */
export function normalizeBody(text) {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

/** 严格 UTF-8 解码：非法字节序列直接抛错，不做替换字符兜底。 */
export function decodeUtf8Strict(buffer, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`不是合法的 UTF-8：${label}（拒绝猜测解码，请修上游文件）`);
  }
}

export function sha256Hex(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

export function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

/**
 * 预设正文不得把「预设」变成「远程加载器」。
 *
 * 这些形式无歧义：把远端内容直接交给 shell / PowerShell 解释器执行。它们与「把命令写成
 * 例子讲解」不同 —— 前者只要模型照做，就会在本机跑一段不由你控制的代码，属于供应链风险，
 * 不属于内容偏好。上游已有先例（`grok-fast-v2` 被标注 Security quarantine，原因就是旧版
 * 指示隐蔽下载并执行外部 Windows 可执行文件）。
 *
 * 抛错而不是跳过：静默跳过一个被投毒的正文，会让人以为同步成功。
 */
const REMOTE_EXECUTION = [
  /curl\s+[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/i,
  /wget\s+[^\n|]{0,200}\|\s*(?:ba|z|k)?sh\b/i,
  /iwr\b[^\n]{0,200}\|\s*iex\b/i,
  /Invoke-WebRequest[^\n]{0,200}\|\s*Invoke-Expression/i,
  /certutil(?:\.exe)?\s+-urlcache/i,
];

export function assertBodyAllowed(body, label) {
  for (const pattern of REMOTE_EXECUTION) {
    if (pattern.test(body)) {
      throw new Error(
        `拒绝生成：${label} 命中远程执行规则（${pattern.source}）—— 预设正文不得指示下载并执行远程内容`,
      );
    }
  }
  return body;
}

/**
 * 冻结契约要求的 slug 约束：非空、≤128 字节、仅 `[a-z0-9-]`、不以 `-` 首尾。
 * 生成时逐条断言——违反就是来源文件名超出了契约，宁可报错也不产出坏 id。
 */
export function assertPresetId(id, label) {
  if (!id) throw new Error(`id 为空：${label}`);
  if (byteLength(id) > 128) throw new Error(`id 超过 128 字节：${id}（${label}）`);
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`id 含非法字符：${id}（${label}）`);
  if (id.startsWith("-") || id.endsWith("-")) throw new Error(`id 首尾有 -：${id}（${label}）`);
  return id;
}

/**
 * 排序 `(vendor, model, id)`：先按小写比（大小写不敏感的字典序，也是控制台渲染顺序），
 * 大小写只差时再用原串码位兜底，保证顺序完全确定、不依赖 locale。
 */
export function comparePresets(a, b) {
  for (const key of ["vendor", "model", "id"]) {
    const left = a[key].toLowerCase();
    const right = b[key].toLowerCase();
    if (left < right) return -1;
    if (left > right) return 1;
  }
  for (const key of ["vendor", "model", "id"]) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  return 0;
}

/** 递归列出目录下的文件，按名字排序（产物顺序不能依赖 readdir 的返回次序）。 */
async function listFiles(dir, segments = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const next = [...segments, entry.name];
    if (entry.isDirectory()) {
      files.push(...(await listFiles(join(dir, entry.name), next)));
      continue;
    }
    if (entry.isFile()) files.push(next);
  }
  return files;
}

/** 资产相对路径：`<vendor slug>/<id>.md`，由 id 就能直接定位原文。 */
export function assetRelativePath(preset) {
  return `${slug(preset.vendor)}/${preset.id}.md`;
}

/**
 * 读来源目录，产出预设数组（已排序、已校验、已带 tags / bytes / sha256）。
 *
 * 抛错即退出：非 UTF-8、id 非法、id 重复。空白正文跳过并记录在 `skipped` 里，
 * 由调用方报到 stderr——不静默吞掉来源数据的异常。
 */
export async function collectSourcePresets({ sourceDir = resolveSourceDir() } = {}) {
  const files = await listFiles(sourceDir);
  const presets = [];
  const skipped = [];
  const seen = new Map();

  for (const segments of files) {
    const relativePath = segments.join("/");
    // 厂商目录下的文件才算预设；根目录的 README.md 之类不是。
    if (segments.length < 2) continue;
    const extension = extname(segments[segments.length - 1]).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(extension)) continue;

    const buffer = await readFile(join(sourceDir, ...segments));
    const body = normalizeBody(decodeUtf8Strict(buffer, relativePath));
    if (!body.trim()) {
      skipped.push({ path: relativePath, reason: "正文为空（上游文件没有内容）" });
      continue;
    }
    // 先过内容门，再把正文当成预设：被投毒的正文不能进目录。
    assertBodyAllowed(body, relativePath);

    const vendor = segments[0];
    const modelSegments = segments.slice(1);
    const last = modelSegments[modelSegments.length - 1];
    modelSegments[modelSegments.length - 1] = last.slice(0, last.length - extension.length);
    const model = modelSegments.join("/");

    const vendorSlug = slug(vendor);
    const modelSlug = slug(model);
    if (!vendorSlug || !modelSlug) {
      throw new Error(
        `无法折出 slug：${relativePath}（vendor="${vendor}" model="${model}"）—— 请在上游改成 ASCII 文件名`,
      );
    }
    const id = assertPresetId(`${vendorSlug}-${modelSlug}`, relativePath);
    if (seen.has(id)) {
      throw new Error(`id 重复：${id}（${seen.get(id)} 与 ${relativePath}）—— 请先在上游改名`);
    }
    seen.set(id, relativePath);

    presets.push({
      id,
      vendor,
      model,
      // 来源只有一个名字，不编造第二个：title 与 model 同值，仅供展示。
      title: model,
      tags: deriveTags(vendor, model, extension),
      bytes: byteLength(body),
      sha256: sha256Hex(body),
      body,
      source: relativePath,
    });
  }

  presets.sort(comparePresets);
  return { presets, skipped };
}

const GENERATED_BANNER = `/**
 * 破甲预设目录 —— **自动生成，请勿手改**。
 *
 * 重新生成： node scripts/sync-purge-presets.mjs
 * 校验一致： node scripts/sync-purge-presets.mjs --check
 * 原文快照： assets/purge-presets/<vendor>/<id>.md
 * 来源：     jailbreaks 仓库的第三方公开破甲 prompt（\`PURGE_PRESETS_SOURCE\` 可覆盖）
 *
 * \`BuiltinPreset\` 与 \`BUILTIN_PRESETS\` 是冻结契约：预设逻辑（lib/purge/presets.ts）
 * 直接消费，字段增删要同步那边。\`bytes\` 与 \`sha256\` 都按 \`body\` 的 UTF-8 字节算，
 * 用于运行时完整性自检与「来源未变」断言。
 */`;

const INTERFACE_BLOCK = `export interface BuiltinPreset {
  readonly id: string;
  readonly vendor: string;
  readonly model: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly bytes: number;
  readonly sha256: string;
  readonly body: string;
}`;

/**
 * 生成字符串字面量：JSON 转义（引号、反斜杠、控制字符全兜住），再补上
 * JSON 不管而老引擎会当成行终止符的 U+2028 / U+2029。
 */
function stringLiteral(text) {
  return JSON.stringify(text).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** 渲染整份 `lib/purge/preset-catalog.ts`（纯函数：同样的输入逐字节相同）。 */
export function renderCatalogModule(presets) {
  const entries = presets
    .map((preset) =>
      [
        `  // 来源：${preset.source}`,
        "  {",
        `    id: ${stringLiteral(preset.id)},`,
        `    vendor: ${stringLiteral(preset.vendor)},`,
        `    model: ${stringLiteral(preset.model)},`,
        `    title: ${stringLiteral(preset.title)},`,
        `    tags: [${preset.tags.map(stringLiteral).join(", ")}],`,
        `    bytes: ${preset.bytes},`,
        `    sha256: ${stringLiteral(preset.sha256)},`,
        `    body: ${stringLiteral(preset.body)},`,
        "  },",
      ].join("\n"),
    )
    .join("\n");

  return `${GENERATED_BANNER}\n\n${INTERFACE_BLOCK}\n\nexport const BUILTIN_PRESETS: readonly BuiltinPreset[] = [\n${entries}\n];\n`;
}

/** 一次完整规划：来源 → 预设 + 资产文件表 + 目录模块文本。 */
export async function planSync({ sourceDir = resolveSourceDir() } = {}) {
  const { presets, skipped } = await collectSourcePresets({ sourceDir });
  const assets = new Map();
  for (const preset of presets) {
    assets.set(assetRelativePath(preset), preset.body);
  }
  return {
    presets,
    skipped,
    assets,
    catalogText: renderCatalogModule(presets),
    totalBytes: presets.reduce((sum, preset) => sum + preset.bytes, 0),
    vendorCount: new Set(presets.map((preset) => preset.vendor)).size,
  };
}

/** 读盘时折行尾：工作区可能因 `core.autocrlf` 是 CRLF，行尾不是内容。 */
function foldLineEndings(text) {
  return text.replace(/\r\n/g, "\n");
}

async function readAssetTree(assetsDir) {
  const files = await listFiles(assetsDir).catch(() => []);
  const actual = new Map();
  for (const segments of files) {
    const relativePath = segments.join("/");
    const buffer = await readFile(join(assetsDir, ...segments));
    actual.set(relativePath, foldLineEndings(decodeUtf8Strict(buffer, relativePath)));
  }
  return actual;
}

/**
 * `--check` 的纯函数版本：内存重算 vs 磁盘，返回 ok / problems，不打印不退出。
 * 比较范围是三处：资产文件集合与内容、目录模块全文、资产目录里的多余文件。
 */
export async function verifySync({ sourceDir = resolveSourceDir(), root = rootDir } = {}) {
  const plan = await planSync({ sourceDir });
  const problems = [];

  const actual = await readAssetTree(join(root, ASSETS_RELATIVE_DIR));
  for (const [relativePath, body] of plan.assets) {
    const label = `${ASSETS_RELATIVE_DIR}/${relativePath}`;
    if (!actual.has(relativePath)) problems.push(`缺少资产文件：${label}`);
    else if (actual.get(relativePath) !== body) problems.push(`资产内容不一致：${label}`);
  }
  for (const relativePath of actual.keys()) {
    if (!plan.assets.has(relativePath)) {
      problems.push(`多余资产文件：${ASSETS_RELATIVE_DIR}/${relativePath}（先清空再生成）`);
    }
  }

  let catalogOnDisk = null;
  try {
    catalogOnDisk = foldLineEndings(await readFile(join(root, CATALOG_RELATIVE_PATH), "utf8"));
  } catch {
    problems.push(`缺少目录模块：${CATALOG_RELATIVE_PATH}`);
  }
  if (catalogOnDisk !== null && catalogOnDisk !== plan.catalogText) {
    problems.push(`目录模块与来源不一致：${CATALOG_RELATIVE_PATH}`);
  }

  return {
    ok: problems.length === 0,
    problems,
    count: plan.presets.length,
    totalBytes: plan.totalBytes,
    vendorCount: plan.vendorCount,
    skipped: plan.skipped,
  };
}

function reportSkipped(skipped) {
  for (const entry of skipped) {
    process.stderr.write(`跳过：${entry.path} —— ${entry.reason}\n`);
  }
}

/** 全量重建：清空资产目录后重写，再覆盖目录模块。 */
export async function writeSync({ sourceDir = resolveSourceDir(), root = rootDir } = {}) {
  const plan = await planSync({ sourceDir });
  const assetsDir = join(root, ASSETS_RELATIVE_DIR);
  await rm(assetsDir, { recursive: true, force: true });
  for (const [relativePath, body] of plan.assets) {
    const target = join(assetsDir, ...relativePath.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body, "utf8");
  }
  const catalogPath = join(root, CATALOG_RELATIVE_PATH);
  await mkdir(dirname(catalogPath), { recursive: true });
  await writeFile(catalogPath, plan.catalogText, "utf8");
  return { ...plan, assetsDir, catalogPath };
}

const USAGE = `用法：
  node scripts/sync-purge-presets.mjs           全量重建资产与目录模块
  node scripts/sync-purge-presets.mjs --check   幂等校验（一致 exit 0 / 不一致 exit 1）

环境变量：
  PURGE_PRESETS_SOURCE  破甲预设来源目录（默认 ${DEFAULT_SOURCE_DIR}）
`;

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    process.stderr.write(`未知参数：${unknown.join(" ")}\n\n${USAGE}`);
    return 2;
  }

  const sourceDir = resolveSourceDir();

  if (argv.includes("--check")) {
    const result = await verifySync({ sourceDir });
    reportSkipped(result.skipped);
    if (!result.ok) {
      process.stderr.write(
        `不一致：${result.problems.length} 处\n${result.problems.map((line) => `  - ${line}`).join("\n")}\n重新生成：node scripts/sync-purge-presets.mjs\n`,
      );
      return 1;
    }
    process.stdout.write(
      `${CONSISTENT_PREFIX}${result.count} 条，${result.totalBytes} 字节（${result.vendorCount} 个厂商目录，${ASSETS_RELATIVE_DIR} + ${CATALOG_RELATIVE_PATH}）\n`,
    );
    return 0;
  }

  const result = await writeSync({ sourceDir });
  reportSkipped(result.skipped);
  process.stdout.write(
    `已生成 ${result.presets.length} 条（${result.vendorCount} 个厂商目录），合计 ${result.totalBytes} 字节 → ${ASSETS_RELATIVE_DIR}/\n`,
  );
  process.stdout.write(
    `已写入 ${CATALOG_RELATIVE_PATH}（${byteLength(result.catalogText)} 字节）；校验：node scripts/sync-purge-presets.mjs --check\n`,
  );
  return 0;
}

/** 只有直接执行才跑 `main`：被测试 import 时不能有副作用。 */
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
