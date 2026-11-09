/**
 * pi-agent-desktop 内置接线：把跨端扩展（lsp-mcp / pi-team / pi-purge / goal）的工厂包成
 * `builtin:` 扩展，交给普通会话的 extensionFactories。
 *
 * 形态与 lib/builtin-extensions.ts 的 `builtin(name, factory)` 一致：`builtin: true`
 * 让 SDK 把它当 `builtin:<name>` 资源——默认加载，`-builtin:<name>` 或 `--no-extensions`
 * 可关闭。`replaceable: true` 允许用户用同名工具/命令的第三方扩展顶替。
 *
 * 接线到两处（都在 lib/rpc-manager.ts 与 lib/subagent-runtime.ts）：
 *   - **普通会话**：四个扩展全给（normal-session 分支）。
 *   - **团队成员（子会话）**：只给 pi-lsp 与 pi-team，且 pi-team **不带 controller** ——
 *     成员因此只有邮箱，派发在宿主层结构性抛错（见 lib/builtin-extensions.ts 的
 *     `createSubagentBuiltinExtensions`）。chat-only 与 workspace chat 仍然一个都不给：
 *     团队工具会派发子会话，属于 agent 委派能力，不应出现在聊天策略下；LSP 也只在真正的
 *     项目会话里才有意义；pi-purge 的 `/purge` 命令在聊天策略下没有意义。
 */
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPiTeamExtension } from "pi-team";
import lspExtension from "lsp-mcp";
import { createSubagentTeamHost, createUnavailableTeamHost } from "./pi-team-host";
import { createGoalExtension } from "./goal/goal-extension";
import { PI_EXTENSION_BUILTIN_NAMES } from "./pi-extension-names";
import { isBuiltInSubagentsEnabled } from "./subagent-settings";
import type { SubagentController } from "./subagent-runtime";
import { sanitizeTeamName, teamDirFor } from "./agent-teams-swimlane-store";

// pi-purge 的加载方式与另两个不同，这里必须用运行时加载而不是顶层 import：
// 它不编译、不发 dist，入口是纯 TS 源码 `extensions/pi-purge.ts`，且 package.json
// 没有 main / exports —— 只能按子路径导入那个 .ts 文件本身。
// 顶层 `import "pi-purge/extensions/pi-purge.ts"` 会被 webpack 静态解析，
// 而它的 loader 链把该文件当 JS 解析（`import type` 是 TS 语法）→ build 直接失败；
// `serverExternalPackages` 只按**包名**匹配，覆盖不到这个子路径。
// 所以走 `webpackIgnore` 的动态 import：打包期完全不碰，运行时由 Node ≥22.19 的
// 原生 type stripping 直接执行 .ts。desktop 的 engines 要求 >=22.19.0，成立。
const PI_PURGE_ENTRY = "pi-purge/extensions/pi-purge.ts";

async function loadPiPurgeExtension(): Promise<(pi: ExtensionAPI) => void> {
  const mod = (await import(/* webpackIgnore: true */ PI_PURGE_ENTRY)) as {
    default?: (pi: ExtensionAPI) => void;
  };
  if (typeof mod.default !== "function") {
    throw new Error(`${PI_PURGE_ENTRY} 没有默认导出的注册钩子`);
  }
  return mod.default;
}

const [LSP_BUILTIN_NAME, TEAM_BUILTIN_NAME, PURGE_BUILTIN_NAME, GOAL_BUILTIN_NAME] = PI_EXTENSION_BUILTIN_NAMES;

function builtin(name: string, factory: (pi: ExtensionAPI) => void | Promise<void>): InlineExtension {
  return { name, factory, replaceable: true, builtin: true };
}

const TEAM_CREATE_TOOL_NAME = "team_create";

/** 命名提示的 system prompt 截面名。 */
export const TEAM_NAMING_SECTION = "team-naming";

// 只对 lead 注入的命名提示。语言中立（英文），因为服务端拿不到 locale —— i18n 只在浏览器
// localStorage，见 docs/i18n.md：i18n 不与服务端耦合，故这里不按语言分叉。
export const TEAM_NAMING_GUIDE = `When you call team_create, team_name must be a path-safe identifier: ASCII letters, digits and hyphens only. It becomes the team's directory name. Put the human-readable name — including a Chinese name — in the description field; that is what the team list shows.

Two names that sanitize to the same identifier collide: every non-ASCII character (e.g. any Chinese character) collapses to a hyphen, so two all-Chinese names both become "-". The second team_create then fails because that directory already exists. Give each team a distinct ASCII team_name.`;

/**
 * team_create 撞目录时的拦截文案。
 *
 * 目录 slug 是把 team_name 里所有非字母数字字符压成 `-` 得出的，因此「前端队」「后端队」
 * 这类中文名的 slug 都是同一串短横线。pi-team 只会回一句「团队 "后端队" 已存在」，用的还是
 * 请求原名 —— 用户会以为「后端队」被占了，完全看不懂。这里说清是**目录名**撞了、跟谁撞。
 */
export function teamCreateCollisionReason(slug: string, existingDisplayName: string): string {
  return `目录名 "${slug}" 已被团队「${existingDisplayName}」占用（中文/符号名会被压成同一串短横线）。`
    + `请给 team_name 一个路径安全的 ASCII 标识符（字母、数字、短横线），人类可读名（含中文名）写进 description。`;
}

/** 读既有团队的 displayName（config.json 的原始 name）；读不到回落 null。 */
function readTeamDisplayName(teamDir: string): string | null {
  try {
    const config = JSON.parse(readFileSync(join(teamDir, "config.json"), "utf8")) as { name?: unknown };
    return typeof config.name === "string" && config.name.trim() ? config.name : null;
  } catch {
    return null;
  }
}

/** LSP 扩展：注册单个 `lsp` 工具，并把 write/edit 后的诊断织入工具结果。 */
function lspBuiltin(): InlineExtension {
  return builtin(LSP_BUILTIN_NAME, (pi) => {
    // 两端的 ExtensionAPI 来自各自 @earendil-works/pi-coding-agent；结构一致，
    // 但跨包类型可能因 minor 版本差异不精确对齐，这里按扩展入口的实参类型收窄。
    lspExtension(pi as unknown as Parameters<typeof lspExtension>[0]);
  });
}

/**
 * 团队扩展：注册 team_* 工具；宿主桥在 session_start 时绑定「哪个会话在跑团队工具」，
 * 从而把 createSubagentController 的 start/resume/steer 复用成团队成员的 spawn/revive/steer。
 *
 * 成员身份（`identity`）不再走进程 env 跨 await 的注入窗口（并发派发会串号，见
 * lib/subagent-runtime.ts 的旧窗口），而是作为参数流进本闭包，在工厂同步函数体内
 * 设置/还原 env：pi-team 的 createTeamRuntime 在构造期同步捕获
 * `process.env.PI_AGENT_NAME / PI_TEAM_NAME`，set → 捕获 → restore 之间没有任何
 * await，对其他并发派发是原子的。
 */
function teamBuiltin(
  controller: SubagentController | undefined,
  identity?: { agentName?: string; teamName?: string },
): InlineExtension {
  return builtin(TEAM_BUILTIN_NAME, (pi) => {
    let sessionContext: ExtensionContext | undefined;
    const host =
      controller && isBuiltInSubagentsEnabled()
        ? createSubagentTeamHost(controller, { getContext: () => sessionContext })
        : createUnavailableTeamHost();
    pi.on("session_start", (_event, ctx) => {
      sessionContext = ctx;
    });
    // team_create 撞目录预检：中文/符号名会被 pi-team 压成同一串短横线（「前端队」「后端队」
    // 的 slug 都是 "---"），pi-team 只会说「团队 "后端队" 已存在」，用户看不懂。这里提前拦下
    // 并说清是目录名撞了、跟哪个既有团队撞。放在 team_create 自己的检查之前。
    pi.on("tool_call", (event) => {
      if (event.toolName !== TEAM_CREATE_TOOL_NAME) return undefined;
      const input = event.input as { team_name?: unknown } | undefined;
      // 与 pi-team 逐字一致：它用未 trim 的 params.team_name 落目录（sanitizeName 会把空格
      // 也压成 '-'），所以这里也不 trim，只拿 trim 结果判空。
      const rawName = typeof input?.team_name === "string" ? input.team_name : "";
      if (!rawName.trim()) return undefined;
      const dir = teamDirFor(rawName);
      if (!existsSync(dir)) return undefined;
      const slug = sanitizeTeamName(rawName);
      const display = readTeamDisplayName(dir) ?? slug;
      return { block: true, reason: teamCreateCollisionReason(slug, display) };
    });
    // 命名提示只给 lead：成员（identity.agentName 存在）不建团队。
    if (!identity?.agentName) {
      pi.on("before_agent_start", (event) => {
        event.systemPromptOptions.sections[TEAM_NAMING_SECTION] = TEAM_NAMING_GUIDE;
        return undefined;
      });
    }
    const previousAgentName = process.env.PI_AGENT_NAME;
    const previousTeamName = process.env.PI_TEAM_NAME;
    const captureIdentity = Boolean(identity?.agentName || identity?.teamName);
    if (captureIdentity) {
      if (identity?.agentName) process.env.PI_AGENT_NAME = identity.agentName;
      if (identity?.teamName) process.env.PI_TEAM_NAME = identity.teamName;
    }
    try {
      createPiTeamExtension(pi as unknown as Parameters<typeof createPiTeamExtension>[0], host);
    } finally {
      if (captureIdentity) {
        if (identity?.agentName) {
          if (previousAgentName === undefined) delete process.env.PI_AGENT_NAME;
          else process.env.PI_AGENT_NAME = previousAgentName;
        }
        if (identity?.teamName) {
          if (previousTeamName === undefined) delete process.env.PI_TEAM_NAME;
          else process.env.PI_TEAM_NAME = previousTeamName;
        }
      }
    }
  });
}

/**
 * prompt 切换扩展：注册 `/purge` 命令，在 pi 内置人设与自定义 prompt 文件之间切换。
 * pi-purge 的默认导出是 `(pi: ExtensionAPI) => void` 的注册钩子（非工厂），
 * 与 builtin() 的 factory 签名直接兼容。加载方式见文件顶部 PI_PURGE_ENTRY 的说明。
 */
function purgeBuiltin(): InlineExtension {
  return builtin(PURGE_BUILTIN_NAME, async (pi) => {
    const register = await loadPiPurgeExtension();
    register(pi);
  });
}

/**
 * 目标模式扩展：注册 `/goal` 命令与 `goal_complete` 工具，每轮结束按双闸（默认 20 轮 /
 * 10 分钟）自动续跑，触顶转 paused。**只给普通项目会话**——chat-only 与团队成员子会话都
 * 不经这里（见文件顶部与 lib/builtin-extensions.ts 的分发口径）。
 */
function goalBuiltin(): InlineExtension {
  return builtin(GOAL_BUILTIN_NAME, createGoalExtension());
}

export interface PiExtensionBuiltinsOptions {
  /** 既有 subagent controller；缺省（子 agent 被关闭）时团队桥降级为不可派发。 */
  subagentController?: SubagentController;
  /** 成员身份（团队成员子会话）：工厂同步体内注入 env 供 pi-team 构造期捕获。 */
  teamIdentity?: { agentName?: string; teamName?: string };
  /** 测试用：只想要某个扩展时传名字集合。 */
  include?: readonly string[];
}

/** 返回四个 `builtin:` 扩展，顺序与 PI_EXTENSION_BUILTIN_NAMES 一致。 */
export function createPiExtensionBuiltins(options: PiExtensionBuiltinsOptions = {}): InlineExtension[] {
  const include = options.include ? new Set(options.include) : undefined;
  const wants = (name: string) => !include || include.has(name);
  return [
    ...(wants(LSP_BUILTIN_NAME) ? [lspBuiltin()] : []),
    ...(wants(TEAM_BUILTIN_NAME)
      ? [teamBuiltin(options.subagentController, options.teamIdentity)]
      : []),
    ...(wants(PURGE_BUILTIN_NAME) ? [purgeBuiltin()] : []),
    ...(wants(GOAL_BUILTIN_NAME) ? [goalBuiltin()] : []),
  ];
}

export { PI_EXTENSION_BUILTIN_NAMES } from "./pi-extension-names";
export type { PiExtensionBuiltinName } from "./pi-extension-names";
