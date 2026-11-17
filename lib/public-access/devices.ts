/**
 * 公网访问的手机设备表（服务端专用，不依赖 pi SDK）。
 *
 * 形态对齐 cc-haha 的 `src/server/publicAccess.ts`：桌面在配对批准后给手机签发
 * 一枚长期 device token，服务端**只落盘 `sha256(token)`**（明文只出现在给手机的
 * 那一次响应里），浏览器把它放在 `__Host-pi-remote` Cookie 里。设备表与
 * settings.json 同目录（`~/.pi/agent/pi-web/public-access-devices.json`），
 * 0600 私有文件 + 原子替换，范式照抄 lib/remote-access.ts / lib/relay/store.ts。
 *
 * 失败语义：
 * - 文件缺失 / 损坏 / 版本不认识 → 视为「没有任何设备」（fail-closed：手机需要重新配对）。
 * - 过期设备在读取时就被排除；文件里的过期项留到下一次写操作时清掉。
 * - 校验只看 sha256，恒定时间比较；设备令牌绝不出现在任何给浏览器的 DTO 里。
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file.ts";
import { remoteAccessSettingsPath } from "../remote-access.ts";

/** 相对设置文件同目录的设备表文件名。 */
export const PUBLIC_ACCESS_DEVICES_FILE = "public-access-devices.json";
/** 浏览器（以及未来原生客户端）携带设备令牌的 Cookie 名。与 cc-haha 的 `__Host-haha-remote` 同义不同名。 */
export const PUBLIC_ACCESS_DEVICE_COOKIE = "__Host-pi-remote";
/** 设备令牌默认有效期：30 天（cc-haha 的 SESSION_TTL）。 */
export const PUBLIC_ACCESS_DEVICE_TTL_MS = 30 * 24 * 60 * 60_000;
/** 设备表上限（cc-haha 同值：32）。 */
export const PUBLIC_ACCESS_MAX_DEVICES = 32;
/** 令牌最长 512 字符：挡住畸形/超长头，真正校验只看 sha256。 */
const MAX_TOKEN_LENGTH = 512;
/** lastUsedAt 的落盘节流：每个设备最多每分钟写一次，避免每请求都改文件。 */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export interface PublicAccessDevice {
  id: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  /** sha256(token) 的 hex；明文永不落盘。 */
  tokenHash: string;
  lastUsedAt?: number;
}

/** 给桌面 UI 的设备视图：不含 tokenHash（连哈希都不该离开服务端）。 */
export interface PublicAccessDeviceView {
  id: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
}

interface DeviceStore {
  version: 1;
  devices: PublicAccessDevice[];
}

/** `~/.pi/agent/pi-web/public-access-devices.json`（跟随 PI_CODING_AGENT_DIR）。 */
export function publicAccessDevicesPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(remoteAccessSettingsPath(env)), PUBLIC_ACCESS_DEVICES_FILE);
}

/** 服务端对令牌的唯一表示。 */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 新设备令牌：32 字节随机数的 base64url（43 字符），与一次性 secret 同源。 */
export function newDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStoredDevice(value: unknown): value is PublicAccessDevice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const device = value as Record<string, unknown>;
  return typeof device.id === "string" && device.id.length > 0
    && typeof device.name === "string"
    && isFiniteTimestamp(device.createdAt)
    && isFiniteTimestamp(device.expiresAt)
    && typeof device.tokenHash === "string" && /^[a-f0-9]{64}$/.test(device.tokenHash)
    && (device.lastUsedAt === undefined || isFiniteTimestamp(device.lastUsedAt));
}

function parseStore(value: unknown): DeviceStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { version: 1, devices: [] };
  const record = value as Record<string, unknown>;
  // 未来版本用别的 schema：宁可全部作废（手机重新配对），也不猜着读。
  if (record.version !== undefined && record.version !== 1) return { version: 1, devices: [] };
  const devices = Array.isArray(record.devices) ? record.devices.filter(isStoredDevice) : [];
  return { version: 1, devices };
}

// 每请求都会读（proxy.ts 的设备分支），按 mtime+size 缓存解析结果。
let cache: { path: string; mtimeMs: number; size: number; store: DeviceStore } | null = null;

function readDeviceStore(path = publicAccessDevicesPath()): DeviceStore {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    cache = null;
    return { version: 1, devices: [] };
  }
  if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.store;
  }
  let store: DeviceStore = { version: 1, devices: [] };
  try {
    store = parseStore(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    store = { version: 1, devices: [] };
  }
  cache = { path, mtimeMs: stat.mtimeMs, size: stat.size, store };
  return store;
}

function writeDeviceStore(store: DeviceStore, path = publicAccessDevicesPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify(store, null, 2));
  cache = null;
}

function toView(device: PublicAccessDevice): PublicAccessDeviceView {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    expiresAt: device.expiresAt,
    lastUsedAt: device.lastUsedAt ?? null,
  };
}

/** 设备名的唯一清洗点：控制字符剔除、去首尾空白、80 字符封顶。 */
export function sanitizeDeviceName(value: unknown): string {
  if (typeof value !== "string") return "Mobile browser";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return cleaned || "Mobile browser";
}

/**
 * 签发一台设备（配对模块是唯一调用方）。令牌明文只在返回值里出现一次，
 * 落盘的只有 sha256；同时顺手清掉已过期项。
 */
export function createDevice(input: {
  id?: string;
  name: unknown;
  now?: number;
  ttlMs?: number;
}): { device: PublicAccessDeviceView; token: string } {
  const now = input.now ?? Date.now();
  const token = newDeviceToken();
  const device: PublicAccessDevice = {
    id: input.id && input.id.length > 0 ? input.id : randomUUID(),
    name: sanitizeDeviceName(input.name),
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? PUBLIC_ACCESS_DEVICE_TTL_MS),
    tokenHash: hashDeviceToken(token),
  };
  const store = readDeviceStore();
  store.devices = [...store.devices.filter((entry) => entry.expiresAt > now), device];
  writeDeviceStore(store);
  return { device: toView(device), token };
}

/** 当前未过期设备数（配对时的上限判定）。 */
export function countDevices(now = Date.now()): number {
  return readDeviceStore().devices.filter((device) => device.expiresAt > now).length;
}

/** 未过期设备列表（按签发时间排序）；永不返回 tokenHash。 */
export function listDevices(now = Date.now()): PublicAccessDeviceView[] {
  return readDeviceStore().devices
    .filter((device) => device.expiresAt > now)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(toView);
}

/**
 * 校验设备令牌。命中且未过期时返回设备视图（附带节流的 lastUsedAt 更新），
 * 否则 null。请求门禁（lib/request-security.ts、proxy.ts）的唯一入口。
 */
export function verifyDeviceToken(token: string | null | undefined, now = Date.now()): PublicAccessDeviceView | null {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const hash = hashDeviceToken(token);
  const store = readDeviceStore();
  const device = store.devices.find((entry) =>
    entry.expiresAt > now && timingSafeEqual(Buffer.from(entry.tokenHash, "hex"), Buffer.from(hash, "hex")));
  if (!device) return null;
  // 最后使用时间只在明显变旧时才写盘，避免每个请求都改文件。
  if (now - (device.lastUsedAt ?? 0) >= LAST_USED_WRITE_INTERVAL_MS) {
    device.lastUsedAt = now;
    writeDeviceStore(store);
  }
  return toView(device);
}

/** 撤销一台设备；返回是否真的删掉了什么。撤销即刻生效（下次校验就查不到）。 */
export function revokeDevice(id: string, now = Date.now()): boolean {
  const store = readDeviceStore();
  const next = store.devices.filter((device) => device.id !== id);
  const removed = next.length !== store.devices.length;
  if (!removed) {
    // 仍然清一次过期项：撤销按钮点的是列表里的行，列表本身已排除过期项。
    const pruned = store.devices.filter((device) => device.expiresAt > now);
    if (pruned.length !== store.devices.length) writeDeviceStore({ version: 1, devices: pruned });
    return false;
  }
  writeDeviceStore({ version: 1, devices: next.filter((device) => device.expiresAt > now) });
  return true;
}

/**
 * 浏览器写 Cookie 的完整头值。`__Host-` 前缀要求 Secure + Path=/ 且无 Domain；
 * HttpOnly 让页面脚本拿不到令牌，SameSite=Strict 挡住跨站携带。语义与 cc-haha
 * 的 `__Host-haha-remote` 一致，名字换成 Pi 自己的。
 */
export function deviceCookieHeader(token: string, ttlMs = PUBLIC_ACCESS_DEVICE_TTL_MS): string {
  return `${PUBLIC_ACCESS_DEVICE_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1000)}`;
}

function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim() || null;
  }
  return null;
}

/**
 * 请求携带的设备令牌：`__Host-pi-remote` Cookie 优先，其次 `Authorization: Bearer`
 * （脚本/未来原生客户端用；浏览器侧只走 HttpOnly Cookie）。
 */
export function deviceTokenFromRequest(request: Pick<Request, "headers">): string | null {
  const cookie = cookieValue(request.headers.get("cookie"), PUBLIC_ACCESS_DEVICE_COOKIE);
  if (cookie) return cookie;
  const authorization = request.headers.get("authorization");
  const bearer = authorization ? /^Bearer\s+(\S+)$/i.exec(authorization)?.[1] : undefined;
  return bearer ?? null;
}

/** 该请求是否持有有效设备令牌（配对过的手机）。 */
export function isDeviceAuthenticatedRequest(request: Pick<Request, "headers">, now = Date.now()): boolean {
  return verifyDeviceToken(deviceTokenFromRequest(request), now) !== null;
}

/**
 * 手机还处在「配对中」时唯一可以免鉴权访问的路径。
 * 它们只认一次性 secret / claimSecret，且 proxy.ts 只在隧道公网域名上放行。
 */
export function isPublicAccessPairingPath(pathname: string): boolean {
  return pathname === "/pair"
    || pathname === "/api/public-access/pair"
    || pathname === "/api/public-access/pair/claim";
}
