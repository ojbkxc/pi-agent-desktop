import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { remoteAccessSettingsPath } from "./remote-access.ts";

/**
 * Web 密码的设置文件来源（env `PI_WEB_PASSWORD` 之外的第二来源）。
 *
 * 记录与 remoteAccess / publicAccess 共用 `~/.pi/agent/pi-web/settings.json`，
 * 只占 `webPassword` 一个键，存 scrypt hash + salt，绝不存明文。proxy 与
 * request-security 在每个请求上读它，所以解析结果按文件的 mtime+size 缓存；
 * 任何写操作后清缓存（范式照抄 lib/remote-access.ts 与 lib/public-access/settings.ts）。
 *
 * env 变量优先：只要 `PI_WEB_PASSWORD` 非空，这里的记录被完全遮蔽——判定、
 * 校验与改密都由 lib/web-auth.ts 按这个优先级分发，本模块只管存取与校验一个记录。
 *
 * 文件缺失/损坏/字段形状不对一律按「未设置」处理：fail-closed 只会让隧道开
 * 不起来，而本机回到无密码的旧行为，与 remoteAccess 的读法一致。
 */

export const WEB_PASSWORD_VERSION = 1;

/**
 * OWASP 推荐档：N=2^14、r=8、p=1、64 字节输出。校验一次约几十毫秒，只有真正的
 * 口令校验（登录 POST、Basic 头、改密时的当前密码）才走它；会话 cookie 的校验
 * 只用 HMAC（密钥是存储的 hash，见 lib/web-auth.ts），不会在每个请求上跑 scrypt。
 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 32;

const HEX_SALT = /^[0-9a-f]{64}$/i;
const HEX_HASH = /^[0-9a-f]{128}$/i;

export interface WebPasswordRecord {
  version: number;
  /** 32 字节随机盐，hex。 */
  salt: string;
  /** scrypt 输出的 64 字节 hash，hex。它同时是会话 token 的 HMAC 密钥：改密即轮换。 */
  hash: string;
  updatedAt: string;
}

/** 与 remoteAccess / publicAccess 同一个设置文件。 */
export function webPasswordSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return remoteAccessSettingsPath(env);
}

export function hashWebPassword(
  password: string,
  salt: Buffer = randomBytes(SALT_BYTES),
): { salt: string; hash: string } {
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

function parseWebPassword(value: unknown): WebPasswordRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== WEB_PASSWORD_VERSION) return null;
  if (typeof record.salt !== "string" || !HEX_SALT.test(record.salt)) return null;
  if (typeof record.hash !== "string" || !HEX_HASH.test(record.hash)) return null;
  return {
    version: WEB_PASSWORD_VERSION,
    salt: record.salt,
    hash: record.hash,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
}

let cache: { path: string; mtimeMs: number; size: number; record: WebPasswordRecord | null } | null = null;

/**
 * 读存储的密码记录，没有则 null。每请求调用，按 mtime+size 缓存解析结果；
 * 写操作（本模块的两个写函数）会主动清缓存。
 */
export function readWebPasswordRecord(settingsPath = webPasswordSettingsPath()): WebPasswordRecord | null {
  let stat;
  try {
    stat = statSync(settingsPath);
  } catch {
    cache = null;
    return null;
  }
  if (cache && cache.path === settingsPath && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.record;
  }
  let record: WebPasswordRecord | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      record = parseWebPassword((parsed as { webPassword?: unknown }).webPassword);
    }
  } catch {
    record = null;
  }
  cache = { path: settingsPath, mtimeMs: stat.mtimeMs, size: stat.size, record };
  return record;
}

function readStored(settingsPath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw new Error("Invalid Pi Web settings: expected an object");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function persist(next: Record<string, unknown>, settingsPath: string): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify(next, null, 2));
  cache = null;
}

/** 写入密码记录（新 salt + hash），保留文件里的其它键。 */
export function writeWebPasswordRecord(password: string, settingsPath = webPasswordSettingsPath()): void {
  const { salt, hash } = hashWebPassword(password);
  const stored = readStored(settingsPath);
  persist(
    {
      ...stored,
      version: 1,
      webPassword: {
        version: WEB_PASSWORD_VERSION,
        salt,
        hash,
        updatedAt: new Date().toISOString(),
      },
    },
    settingsPath,
  );
}

/** 删除密码记录（关闭密码），保留文件里的其它键；本来没有记录时不动文件。 */
export function clearWebPasswordRecord(settingsPath = webPasswordSettingsPath()): void {
  const stored = readStored(settingsPath);
  if (stored.webPassword === undefined) return;
  const next = { ...stored };
  delete next.webPassword;
  persist(next, settingsPath);
}

/** 校验口令对记录：timingSafeEqual；形状不对或版本不认识一律 false。 */
export function verifyWebPasswordHash(suppliedPassword: string, record: WebPasswordRecord): boolean {
  if (record.version !== WEB_PASSWORD_VERSION) return false;
  if (!HEX_SALT.test(record.salt) || !HEX_HASH.test(record.hash)) return false;
  const salt = Buffer.from(record.salt, "hex");
  const expected = Buffer.from(record.hash, "hex");
  const actual = scryptSync(suppliedPassword, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return timingSafeEqual(actual, expected);
}
