/**
 * 技能市场的安装 / 卸载 / 已安装标注。
 *
 * 落盘位置：`<agentDir>/skills/<source>-<slug>/`（即 `~/.pi/agent/skills/...`），这是 pi SDK
 * 默认扫描的技能根，装完下一轮会话就能用，不需要额外配置。
 *
 * 安装流程（顺序很重要）：
 *   1. 拉详情 + 文件清单，按 MARKET_LIMITS 校验（文件数 / 单文件 / 总量）；
 *   2. 逐文件下载到**临时目录**，边下边按上游 sha256 校验；任一文件失败 → 整体失败，
 *      临时目录删掉，现有安装保持原样（不做「先删再试」）；
 *   3. 临时目录里写入 `.market-meta.json` 标记；
 *   4. 原子换入目标目录（同盘 rename；跨盘 EXDEV 退回 copy+rm）。
 *
 * 卸载只删带 `.market-meta.json` 的目录：同名但手工放进来的技能不能被这个接口删掉。
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { clawhubProvider } from "./clawhub-provider";
import { skillhubProvider } from "./skillhub-provider";
import { readCache, writeCache, detailCacheKey } from "./market-service";
import {
  MARKET_LIMITS,
  MarketUpstreamError,
  MARKET_SLUG_PATTERN,
  sanitizeDirName,
  type MarketProvider,
  type MarketSource,
  type NormalizedSkill,
  type NormalizedSkillDetail,
} from "./types";

const providers: Record<MarketSource, MarketProvider> = {
  clawhub: clawhubProvider,
  skillhub: skillhubProvider,
};

/** 安装标记文件名：卸载只看这个文件，且安装后它是「这份目录由市场写」的唯一凭据。 */
export const MARKET_META_FILENAME = ".market-meta.json";

/** 单 slug 的安装锁：同一个技能同时只允许一次安装（重复点击、两个窗口）。 */
const registry = globalThis as typeof globalThis & { __piMarketInstalls?: Map<string, Promise<unknown>> };

function inFlight(): Map<string, Promise<unknown>> {
  return registry.__piMarketInstalls ??= new Map();
}

interface MarketMeta {
  source: MarketSource;
  slug: string;
  owner?: string;
  version?: string;
  installedAt: string;
  files: number;
}

/** 市场安装的根目录。 */
export function marketSkillsDir(): string {
  return join(getAgentDir(), "skills");
}

function targetDirFor(source: MarketSource, slug: string): string {
  return join(marketSkillsDir(), sanitizeDirName(source, slug));
}

/** 已有安装的元数据；目录不存在或没有标记文件时为 null。 */
export async function readMarketMeta(dirName: string): Promise<MarketMeta | null> {
  try {
    const raw = await readFile(join(marketSkillsDir(), dirName, MARKET_META_FILENAME), "utf-8");
    const parsed = JSON.parse(raw) as Partial<MarketMeta>;
    if (typeof parsed.slug !== "string" || typeof parsed.source !== "string") return null;
    return {
      source: parsed.source as MarketSource,
      slug: parsed.slug,
      ...(typeof parsed.owner === "string" ? { owner: parsed.owner } : {}),
      ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
      installedAt: typeof parsed.installedAt === "string" ? parsed.installedAt : "",
      files: typeof parsed.files === "number" ? parsed.files : 0,
    };
  } catch {
    return null;
  }
}

/** 该目录是否是市场装的（有标记文件）。 */
async function isMarketInstalled(dirName: string): Promise<boolean> {
  return (await readMarketMeta(dirName)) !== null;
}

/**
 * 上游给的相对路径是否是安全的落盘相对路径：
 * 不是绝对路径、不含 `..` 段、不含 NUL、长度合理。这是安装路径穿越的唯一闸门。
 */
export function isSafeRelativePath(filePath: string): boolean {
  if (!filePath || filePath.length > 512) return false;
  if (filePath.includes("\0")) return false;
  if (isAbsolute(filePath)) return false;
  // 统一成平台分隔符后再判定，`a/../../b` 与 `a\\..\\..\\b` 都一样拒。
  const normalized = normalize(filePath.split("/").join(sep));
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) return false;
  if (filePath.split(/[\\/]/).includes("..")) return false;
  return true;
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

async function moveIntoPlace(tmpDir: string, target: string): Promise<void> {
  try {
    await rename(tmpDir, target);
  } catch (error) {
    // 临时目录与技能目录可能不在同一块盘（Windows 上尤其常见）：退回拷贝再删。
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(tmpDir, target, { recursive: true });
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export interface InstallResult {
  installedPath: string;
  skill: NormalizedSkillDetail;
}

async function performInstall(source: MarketSource, slug: string, owner: string | undefined): Promise<InstallResult> {
  const provider = providers[source];
  const cacheKey = detailCacheKey(source, slug, owner);
  const detail = readCache<NormalizedSkillDetail>(cacheKey)
    ?? await provider.detail(slug, owner);
  writeCache(cacheKey, detail);

  const dirName = sanitizeDirName(source, slug);
  const target = targetDirFor(source, slug);
  const meta = await readMarketMeta(dirName);
  if (existsSync(target) && !meta) {
    throw new MarketUpstreamError(
      source,
      "uninstallRefused",
      `${dirName} 已存在且不是市场安装的目录；请先手动移走再安装`,
    );
  }

  // 文件清单：详情里带就用，没有就单独拉一次（skillhub 的详情已内联，clawhub 也是）。
  const files = detail.files.length > 0
    ? detail.files
    : (await provider.listFiles(slug, owner ?? detail.owner, detail.version)).map((file) => ({
      ...file,
      language: "",
      tooBig: file.size > MARKET_LIMITS.maxFileSize,
    }));
  if (files.length === 0) {
    throw new MarketUpstreamError(source, "notInstallable", "上游没有给出这个技能的文件清单");
  }
  if (files.length > MARKET_LIMITS.maxFileCount) {
    throw new MarketUpstreamError(source, "notInstallable", `文件数 ${files.length} 超过上限 ${MARKET_LIMITS.maxFileCount}`);
  }
  const unsafe = files.find((file) => !isSafeRelativePath(file.path));
  if (unsafe) {
    throw new MarketUpstreamError(source, "notInstallable", `文件路径不安全：${unsafe.path}`);
  }
  const totalSize = files.reduce((sum, file) => sum + (file.size || 0), 0);
  if (totalSize > MARKET_LIMITS.maxTotalSize) {
    throw new MarketUpstreamError(source, "notInstallable", `整包 ${totalSize} 字节超过上限 ${MARKET_LIMITS.maxTotalSize}`);
  }
  const tooBig = files.find((file) => (file.size || 0) > MARKET_LIMITS.maxFileSize);
  if (tooBig) {
    throw new MarketUpstreamError(source, "notInstallable", `文件 ${tooBig.path} 超过单文件上限`);
  }

  await mkdir(marketSkillsDir(), { recursive: true });
  const tmpRoot = join(marketSkillsDir(), `.install-${randomUUID()}`);
  const tmpDir = join(tmpRoot, "skill");
  try {
    await mkdir(tmpDir, { recursive: true });
    for (const file of files) {
      const downloaded = await provider.fetchFile(slug, file.path, owner ?? detail.owner);
      if (file.sha256) {
        const actual = sha256Hex(downloaded.content);
        if (actual !== file.sha256) {
          throw new MarketUpstreamError(
            source,
            "upstreamBadResponse",
            `文件 ${file.path} 校验失败（期望 ${file.sha256.slice(0, 12)}…，实得 ${actual.slice(0, 12)}…）`,
          );
        }
      }
      const destination = join(tmpDir, ...file.path.split(/[\\/]/).filter(Boolean));
      // 双保险：normalize 后必须仍在 tmpDir 之内。
      const rootWithSep = tmpDir.endsWith(sep) ? tmpDir : `${tmpDir}${sep}`;
      if (!normalize(destination).startsWith(normalize(rootWithSep)) && normalize(destination) !== normalize(tmpDir)) {
        throw new MarketUpstreamError(source, "notInstallable", `文件路径越界：${file.path}`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, downloaded.content, "utf-8");
    }

    const metaPayload: MarketMeta = {
      source,
      slug,
      ...(owner ?? detail.owner ? { owner: owner ?? detail.owner } : {}),
      ...(detail.version ? { version: detail.version } : {}),
      installedAt: new Date().toISOString(),
      files: files.length,
    };
    await writeFile(join(tmpDir, MARKET_META_FILENAME), JSON.stringify(metaPayload, null, 2), "utf-8");

    // 覆盖安装：先把旧目录挪开，成功后删；失败把旧目录挪回来。
    let backup: string | undefined;
    if (existsSync(target)) {
      backup = `${target}.old-${randomUUID()}`;
      await rename(target, backup);
    }
    try {
      await moveIntoPlace(tmpDir, target);
    } catch (error) {
      if (backup && existsSync(backup) && !existsSync(target)) {
        await rename(backup, target).catch(() => {});
      }
      throw error;
    }
    if (backup) await rm(backup, { recursive: true, force: true }).catch(() => {});

    return { installedPath: target, skill: { ...detail, installState: "installed", installedInfo: { version: detail.version, installedAt: metaPayload.installedAt, dirName } } };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/** 安装一个市场技能。同一个 slug 同时只允许一次安装。 */
export async function installMarketSkill(
  source: MarketSource,
  slug: string,
  owner?: string,
): Promise<InstallResult> {
  if (!MARKET_SLUG_PATTERN.test(slug)) {
    throw new MarketUpstreamError(source, "notInstallable", `非法 slug：${slug}`);
  }
  const key = `${source}:${slug}`;
  const running = inFlight().get(key);
  if (running) {
    throw new MarketUpstreamError(source, "installInProgress", `${slug} 正在安装中`);
  }
  const task = performInstall(source, slug, owner);
  inFlight().set(key, task.catch(() => {}));
  try {
    return await task;
  } finally {
    inFlight().delete(key);
  }
}

export interface UninstallResult {
  removedPath: string;
}

/** 卸载一个市场技能。只删带标记文件的目录。 */
export async function uninstallMarketSkill(source: MarketSource, slug: string): Promise<UninstallResult> {
  const dirName = sanitizeDirName(source, slug);
  const target = join(marketSkillsDir(), dirName);
  if (!existsSync(target)) {
    throw new MarketUpstreamError(source, "notFound", `${dirName} 未安装`);
  }
  if (!await isMarketInstalled(dirName)) {
    throw new MarketUpstreamError(
      source,
      "uninstallRefused",
      `${dirName} 不是市场安装的技能（缺少 ${MARKET_META_FILENAME}），拒绝删除`,
    );
  }
  await rm(target, { recursive: true, force: true });
  return { removedPath: target };
}

/**
 * 已安装的市场技能：扫技能根下每个目录的 `.market-meta.json`。
 * 只读元数据，不解析 SKILL.md（那是 /api/skills 的活）。
 */
export async function listInstalledMarketSkills(): Promise<Array<MarketMeta & { dirName: string; path: string }>> {
  const root = marketSkillsDir();
  if (!existsSync(root)) return [];
  let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const installed: Array<MarketMeta & { dirName: string; path: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const meta = await readMarketMeta(entry.name);
    if (!meta) continue;
    installed.push({ ...meta, dirName: entry.name, path: join(root, entry.name) });
  }
  return installed.sort((a, b) => (a.installedAt < b.installedAt ? 1 : -1));
}

/**
 * 给一页卡片标注「已安装」：按 `<source>-<slug>` 目录 + 标记文件比对。
 * 每次调用只扫一遍目录，避免逐卡 I/O。
 */
export async function annotateInstallState(items: NormalizedSkill[]): Promise<NormalizedSkill[]> {
  if (items.length === 0) return items;
  const installed = new Map(
    (await listInstalledMarketSkills()).map((meta) => [`${meta.source}:${meta.slug}`, meta]),
  );
  return items.map((item) => {
    const meta = installed.get(`${item.source}:${item.slug}`);
    if (!meta) return { ...item, installState: "installable" };
    return {
      ...item,
      installState: "installed",
      installedInfo: {
        ...(meta.version ? { version: meta.version } : {}),
        ...(meta.installedAt ? { installedAt: meta.installedAt } : {}),
        dirName: meta.dirName,
      },
    };
  });
}

/** 详情页的安装状态（按 slug + source）。 */
export async function installStateFor(source: MarketSource, slug: string): Promise<Pick<NormalizedSkill, "installState" | "installedInfo">> {
  const dirName = sanitizeDirName(source, slug);
  const meta = await readMarketMeta(dirName);
  if (!meta) return { installState: "installable" };
  return {
    installState: "installed",
    installedInfo: {
      ...(meta.version ? { version: meta.version } : {}),
      ...(meta.installedAt ? { installedAt: meta.installedAt } : {}),
      dirName,
    },
  };
}