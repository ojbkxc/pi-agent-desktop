/**
 * 本进程唯一的公网访问管理器，挂在 globalThis 上 —— dev 热重载不会起第二个连接器
 * （与 lib/relay/runtime.ts、lib/rpc-manager.ts 的会话注册表同一个理由）。
 */
import { PublicAccessManager } from "./manager.ts";

type PublicAccessGlobal = typeof globalThis & {
  __piPublicAccessManager?: PublicAccessManager | null;
  __piPublicAccessStarting?: Promise<PublicAccessManager | null>;
};

function shared(): PublicAccessGlobal {
  return globalThis as PublicAccessGlobal;
}

export function getPublicAccessManager(): PublicAccessManager | null {
  return shared().__piPublicAccessManager ?? null;
}

/** 取现成的管理器；没有就建一个（不自动开启隧道）。 */
export function ensurePublicAccessManager(): PublicAccessManager {
  const state = shared();
  state.__piPublicAccessManager ??= new PublicAccessManager();
  return state.__piPublicAccessManager;
}

/** 服务器启动时按配置恢复（instrumentation 调用）；串行化，杜绝并发双起。 */
export function restartPublicAccessFromConfig(): Promise<PublicAccessManager | null> {
  const state = shared();
  const previous = state.__piPublicAccessStarting ?? Promise.resolve(null);
  const next = previous.catch(() => null).then(async () => {
    const existing = state.__piPublicAccessManager;
    state.__piPublicAccessManager = null;
    if (existing) await existing.dispose().catch(() => {});
    const manager = new PublicAccessManager();
    state.__piPublicAccessManager = manager;
    await manager.restore();
    return manager;
  });
  state.__piPublicAccessStarting = next;
  return next;
}

/** 本服务器对外的本机来源（隧道指向它）。 */
export function publicAccessLocalPort(): number {
  const parsed = Number(process.env.PORT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 30141;
}
