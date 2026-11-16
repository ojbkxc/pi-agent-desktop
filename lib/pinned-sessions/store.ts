/**
 * 常驻会话（pin）的**读写**与**liveness 注册**。
 *
 * 两件事在这里合并：
 * 1. `pinned-sessions.json` 的读写（原子写，0600）；
 * 2. 让被 pin 的会话真正「常驻」—— 给它注册一个恒真的
 *    `registerSessionLivenessProvider`。两条驱逐路径
 *    （`resetIdleTimer` / `idleCapCandidate`）都看它。
 *
 * 关键纪律：**每次会话启动/重启恢复都要重新注册**。provider 只活在本进程的
 * globalThis registry 里（`lib/session-liveness.ts`），进程重启后旧 provider 就没了；
 * 若不在会话重建时补注册，pin 会在重启后静默失效。调用点在 rpc-manager 的会话启动处。
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { registerSessionLivenessProvider } from "../session-liveness";
import {
  PINNED_SESSIONS_FILE_NAME,
  asPinnedSessionsFile,
  emptyPinnedSessions,
  findPin,
  removePin,
  upsertPin,
  type PinnedSession,
  type PinnedSessionsFile,
  type SessionRole,
} from "./types";

export function pinnedSessionsFilePath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web", PINNED_SESSIONS_FILE_NAME);
}

export function readPinnedSessions(agentDir = getAgentDir()): PinnedSessionsFile {
  const filePath = pinnedSessionsFilePath(agentDir);
  if (!existsSync(filePath)) return emptyPinnedSessions();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return asPinnedSessionsFile(parsed, filePath);
}

export function writePinnedSessions(file: PinnedSessionsFile, agentDir = getAgentDir()): void {
  const filePath = pinnedSessionsFilePath(agentDir);
  mkdirSync(dirname(filePath), { recursive: true });
  writePrivateFileAtomicSync(filePath, JSON.stringify(file, null, 2));
}

export function pinSession(sessionId: string, role: SessionRole, note?: string, agentDir = getAgentDir()): PinnedSession {
  const now = new Date().toISOString();
  const next = upsertPin(readPinnedSessions(agentDir), sessionId, role, note, now);
  writePinnedSessions(next, agentDir);
  ensurePinnedRegistrations(agentDir);
  return findPin(next, sessionId)!;
}

export function unpinSession(sessionId: string, agentDir = getAgentDir()): void {
  writePinnedSessions(removePin(readPinnedSessions(agentDir), sessionId), agentDir);
  ensurePinnedRegistrations(agentDir);
}

/**
 * 已注册的 provider 释放句柄（按 sessionId）。放在 globalThis 上：
 * 热重载会重建模块作用域，模块级 Map 会丢句柄，导致「取消 pin 后仍被钉住」。
 */
declare global {
  var __piPinnedSessionReleases: Map<string, () => void> | undefined;
}

function releases(): Map<string, () => void> {
  if (!globalThis.__piPinnedSessionReleases) globalThis.__piPinnedSessionReleases = new Map();
  return globalThis.__piPinnedSessionReleases;
}

/**
 * 按磁盘上的名单，把本进程的 provider 注册表对齐到一致状态：
 * 名单里有的注册（已注册则跳过），名单里没有的释放。
 *
 * 幂等，可在每次会话启动时调用；开销是一次文件读 + 几次 Map 查找。
 */
export function ensurePinnedRegistrations(agentDir = getAgentDir()): { pinned: string[]; released: string[] } {
  let file: PinnedSessionsFile;
  try {
    file = readPinnedSessions(agentDir);
  } catch (error) {
    // 读不出来就不动注册表：宁可留着已注册的（会话多活一会儿），也不要误释放。
    console.error("[pi-web] 读取常驻会话名单失败:", error instanceof Error ? error.message : error);
    return { pinned: [], released: [] };
  }
  const wanted = new Set(file.sessions.map((session) => session.sessionId));
  const released: string[] = [];
  for (const [sessionId, release] of [...releases()]) {
    if (wanted.has(sessionId)) continue;
    release();
    releases().delete(sessionId);
    released.push(sessionId);
  }
  const pinned: string[] = [];
  for (const sessionId of wanted) {
    if (releases().has(sessionId)) {
      pinned.push(sessionId);
      continue;
    }
    const release = registerSessionLivenessProvider({
      name: `pi-web-pinned:${sessionId}`,
      sessionId,
      isActive: () => true,
    });
    releases().set(sessionId, release);
    pinned.push(sessionId);
  }
  return { pinned, released };
}

/** 本进程里该会话是否已被 pin 注册（UI 与路由判定用）。 */
export function isPinnedSessionRegistered(sessionId: string): boolean {
  return releases().has(sessionId);
}

/** 注销全部 pin 注册（测试/关闭用）。 */
export function releaseAllPinnedRegistrations(): void {
  for (const release of releases().values()) release();
  releases().clear();
}

/** 该会话是否被 pin（读盘；供路由与扩展判定）。读失败按「否」处理。 */
export function isSessionPinned(sessionId: string, agentDir = getAgentDir()): boolean {
  try {
    return Boolean(findPin(readPinnedSessions(agentDir), sessionId));
  } catch {
    return false;
  }
}