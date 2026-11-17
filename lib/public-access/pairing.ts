/**
 * 手机扫码配对的状态机（服务端专用，纯逻辑优先）。
 *
 * 流程与 cc-haha 一致：
 *   1. 桌面（本机）调 beginPairing() 生成一次性 secret（TTL 5 分钟），只把
 *      `sha256(secret)` 留在进程内，二维码内容是 `<公网域名>/pair?secret=…`。
 *   2. 手机 POST /api/public-access/pair 携带 secret → 服务端**立即作废**这枚
 *      secret（一次性），登记一条 pending 请求并回一个一次性的 claimSecret。
 *   3. 用户在电脑上 approve / reject；未批准前 claim 只回 `pending`。
 *   4. 手机 POST /api/public-access/pair/claim 携带 id + claimSecret → 批准后
 *      换成长期 device token（设备表只存 sha256，见 devices.ts），路由把它写进
 *      `__Host-pi-remote` Cookie。
 *
 * 状态放在 `globalThis` 上：Next 的每个 route handler 是独立打包入口，
 * 模块级变量不保证跨路由共享（lib/rpc-manager.ts 的 `__piSessions` 同理）。
 * 进程重启会丢掉未完成的配对；已签发的设备令牌在文件里，不受影响。
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  countDevices,
  createDevice,
  PUBLIC_ACCESS_DEVICE_TTL_MS,
  PUBLIC_ACCESS_MAX_DEVICES,
} from "./devices.ts";

/** 一次性配对 secret 的有效期（cc-haha PAIR_TTL）。 */
export const PAIRING_SECRET_TTL_MS = 5 * 60_000;
/** 从扫码到批准/兑换的窗口：超时这条 pending 请求就作废。 */
export const PAIRING_REQUEST_TTL_MS = 10 * 60_000;

export interface PendingPairingView {
  id: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "rejected";
}

export interface PairingSnapshot {
  /** 当前有未过期、未被扫走的配对 secret。 */
  active: boolean;
  expiresAt: number | null;
  pending: PendingPairingView[];
}

interface PendingPairing {
  id: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  claimHash: string;
  status: "pending" | "approved" | "rejected";
}

interface PairingState {
  pairing: { hash: string; expiresAt: number } | null;
  pending: Map<string, PendingPairing>;
}

const GLOBAL_KEY = "__piPublicAccessPairing";

function state(): PairingState {
  const globals = globalThis as typeof globalThis & { [GLOBAL_KEY]?: PairingState };
  let current = globals[GLOBAL_KEY];
  if (!current) {
    current = { pairing: null, pending: new Map() };
    globals[GLOBAL_KEY] = current;
  }
  return current;
}

/** 测试专用：清空进程内的配对状态（不碰设备表）。 */
export function resetPairingForTests(): void {
  state().pairing = null;
  state().pending.clear();
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function secretMatches(supplied: unknown, expectedHash: string): boolean {
  if (typeof supplied !== "string" || supplied.length === 0 || supplied.length > 512) return false;
  return timingSafeEqual(Buffer.from(hashSecret(supplied), "hex"), Buffer.from(expectedHash, "hex"));
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** 清掉过期的 pending 请求；作废过期的配对 secret。 */
function prune(now: number): void {
  const current = state();
  for (const [id, pending] of current.pending) {
    if (pending.expiresAt <= now) current.pending.delete(id);
  }
  if (current.pairing && current.pairing.expiresAt <= now) current.pairing = null;
}

function view(pending: PendingPairing): PendingPairingView {
  return {
    id: pending.id,
    name: pending.name,
    createdAt: pending.createdAt,
    expiresAt: pending.expiresAt,
    status: pending.status,
  };
}

/**
 * 生成一枚新的配对 secret（新的二维码）。旧的 secret 立即作废——同时只允许
 * 一个二维码有效，避免屏幕上两个码各自握手。pending 请求不受影响。
 */
export function beginPairing(now = Date.now()): { secret: string; expiresAt: number } {
  prune(now);
  const secret = newSecret();
  const expiresAt = now + PAIRING_SECRET_TTL_MS;
  state().pairing = { hash: hashSecret(secret), expiresAt };
  return { secret, expiresAt };
}

/** 桌面 UI 的轮询视图：二维码是否还有效 + 等待批准的请求。 */
export function pairingSnapshot(now = Date.now()): PairingSnapshot {
  prune(now);
  const current = state();
  return {
    active: current.pairing !== null,
    expiresAt: current.pairing?.expiresAt ?? null,
    pending: [...current.pending.values()].map(view),
  };
}

export type RedeemPairingResult =
  | { ok: true; id: string; claimSecret: string }
  | { ok: false; reason: "invalid" | "limit" };

/**
 * 手机侧第一步：拿一次性 secret 换一条 pending 请求。
 * secret 校验通过就立刻作废（一次性），无论后续批准与否都不能再用。
 */
export function redeemPairingSecret(
  input: { secret: unknown; name: unknown },
  now = Date.now(),
): RedeemPairingResult {
  prune(now);
  const current = state();
  if (!current.pairing) return { ok: false, reason: "invalid" };
  if (!secretMatches(input.secret, current.pairing.hash)) return { ok: false, reason: "invalid" };
  // 设备上限：已配对 + 正在等待批准的一起算，防止无限堆积 pending。
  if (countDevices(now) + current.pending.size >= PUBLIC_ACCESS_MAX_DEVICES) {
    return { ok: false, reason: "limit" };
  }
  current.pairing = null;
  const id = randomUUID();
  const claimSecret = newSecret();
  current.pending.set(id, {
    id,
    name: typeof input.name === "string" && input.name.trim()
      ? input.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80)
      : "Mobile browser",
    createdAt: now,
    expiresAt: now + PAIRING_REQUEST_TTL_MS,
    claimHash: hashSecret(claimSecret),
    status: "pending",
  });
  return { ok: true, id, claimSecret };
}

export type PairingAnswerResult = "ok" | "not-found" | "answered";

/** 桌面批准（approve）/ 拒绝（reject）一条 pending 请求。 */
export function answerPairing(
  id: string,
  action: "approve" | "reject",
  now = Date.now(),
): PairingAnswerResult {
  prune(now);
  const pending = state().pending.get(id);
  if (!pending) return "not-found";
  if (pending.status !== "pending") return "answered";
  pending.status = action === "approve" ? "approved" : "rejected";
  return "ok";
}

export type ClaimDeviceResult =
  | { status: "approved"; token: string; deviceId: string; expiresAt: number }
  | { status: "pending" | "rejected" | "expired" | "invalid" };

/**
 * 手机侧第二步：拿 id + claimSecret 兑换设备令牌。
 * - 未批准 → pending（手机继续轮询，不消耗 claimSecret）。
 * - 被拒绝 / 过期 → 这条 pending 删除，手机要重新扫码。
 * - 批准 → 建设备（只在这一次返回明文 token），pending 删除（一次性）。
 */
export function claimPairingDevice(
  input: { id: unknown; claimSecret: unknown },
  now = Date.now(),
): ClaimDeviceResult {
  if (typeof input.id !== "string") return { status: "invalid" };
  const current = state();
  // 清掉别的过期请求，但把目标这条留到下面判定：手机需要看到「过期」而不是
  // 「无效」，前者说明要重新扫码，后者说明凭据不对。
  for (const [pendingId, pending] of current.pending) {
    if (pendingId !== input.id && pending.expiresAt <= now) current.pending.delete(pendingId);
  }
  const pending = current.pending.get(input.id);
  if (!pending) return { status: "invalid" };
  if (!secretMatches(input.claimSecret, pending.claimHash)) return { status: "invalid" };
  if (pending.expiresAt <= now) {
    current.pending.delete(pending.id);
    return { status: "expired" };
  }
  if (pending.status === "pending") return { status: "pending" };
  if (pending.status === "rejected") {
    current.pending.delete(pending.id);
    return { status: "rejected" };
  }
  const { device, token } = createDevice({ id: pending.id, name: pending.name, now });
  current.pending.delete(pending.id);
  return { status: "approved", token, deviceId: device.id, expiresAt: device.expiresAt };
}

/** 设备令牌有效期（claim 响应里写 Cookie 的 Max-Age 用同一份）。 */
export { PUBLIC_ACCESS_DEVICE_TTL_MS };
