/**
 * Router 角色扩展：给被 pin 为 `router` 的会话注入分派提示。
 *
 * 为什么只做提示、不改工具集：
 * - 工具集由 `lib/tool-presets.ts` 的档位与用户选择决定，扩展无权也无需重写；
 *   调研结论里的「Router 甚至不给 Bash」在本仓落成**提示约束**（明确告诉它别自己动手），
 *   而不是结构性剥夺——剥夺会让用户在 router 会话里连看一眼文件都不行，
 *   而这一版的目标是「先能跑」，不是「用户无感 Session」。
 *
 * 只读盘判定角色（`isSessionPinned` + role），不缓存：用户随时可以取消 pin，
 * 下一轮就该换回普通提示。读盘开销是一次小 JSON 读，每轮一次可以接受。
 */
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { ensurePinnedRegistrations, isSessionPinned, readPinnedSessions } from "./store";
import { ROUTER_GUIDE, ROUTER_SECTION, findPin } from "./types";

export const PINNED_SESSIONS_EXTENSION_NAME = "pi-pinned-sessions";

/** InlineExtension 是「纯工厂 | 带名字的对象」的联合；本扩展恒为后者，导出精确类型。 */
export type PinnedSessionsInlineExtension = Extract<InlineExtension, { factory: unknown }>;

export function createPinnedSessionsExtension(): PinnedSessionsInlineExtension {
  return {
    name: PINNED_SESSIONS_EXTENSION_NAME,
    hidden: true,
    builtin: true,
    replaceable: true,
    factory: (pi) => {
      // 会话启动时对齐一次注册表：进程重启后 provider 全丢，靠这一步把 pin 补回来。
      pi.on("session_start", (_event, ctx) => {
        ensurePinnedRegistrations();
        try {
          const pin = findPin(readPinnedSessions(), ctx.sessionManager.getSessionId());
          if (pin?.role === "router") {
            // 只告知一次，避免每轮都刷：具体分派规则由 system prompt 截面承担。
            ctx.ui.notify("This session is pinned as a router: it stays loaded and delegates work to background workers.", "info");
          }
        } catch {
          // 名单损坏：启动照常，下一轮 before_agent_start 会再判一次。
        }
      });

      pi.on("before_agent_start", (event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        if (!isSessionPinned(sessionId)) return undefined;
        let role: string | undefined;
        try {
          role = findPin(readPinnedSessions(), sessionId)?.role;
        } catch {
          return undefined; // 名单损坏：本次不注入，也不报错打断这轮对话。
        }
        if (role === "router") {
          event.systemPromptOptions.sections[ROUTER_SECTION] = ROUTER_GUIDE;
        }
        return undefined;
      });
    },
  };
}