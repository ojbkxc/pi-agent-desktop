/**
 * pi-agent-desktop 内置接线：把跨端扩展（lsp-mcp / pi-team / pi-purge）的工厂包成 `builtin:`
 * 扩展，交给普通会话的 extensionFactories。
 *
 * 形态与 lib/builtin-extensions.ts 的 `builtin(name, factory)` 一致：`builtin: true`
 * 让 SDK 把它当 `builtin:<name>` 资源——默认加载，`-builtin:<name>` 或 `--no-extensions`
 * 可关闭。`replaceable: true` 允许用户用同名工具/命令的第三方扩展顶替。
 *
 * 只接线到**普通会话**（见 lib/rpc-manager.ts 的 normal-session 分支）：chat-only、
 * 子 agent、以及 workspace chat 都不加载这三个扩展——团队工具会派发子会话，属于
 * agent 委派能力，不应出现在聊天策略下；LSP 也只在真正的项目会话里才有意义；
 * pi-purge 的 `/purge` 命令在聊天策略下没有意义。
 */
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { createPiTeamExtension } from "pi-team";
import lspExtension from "lsp-mcp";
import { createSubagentTeamHost, createUnavailableTeamHost } from "./pi-team-host";
import { PI_EXTENSION_BUILTIN_NAMES } from "./pi-extension-names";
import { isBuiltInSubagentsEnabled } from "./subagent-settings";
import type { SubagentController } from "./subagent-runtime";

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

const [LSP_BUILTIN_NAME, TEAM_BUILTIN_NAME, PURGE_BUILTIN_NAME] = PI_EXTENSION_BUILTIN_NAMES;

function builtin(name: string, factory: (pi: ExtensionAPI) => void | Promise<void>): InlineExtension {
  return { name, factory, replaceable: true, builtin: true };
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
 */
function teamBuiltin(controller: SubagentController | undefined): InlineExtension {
  return builtin(TEAM_BUILTIN_NAME, (pi) => {
    let sessionContext: ExtensionContext | undefined;
    const host =
      controller && isBuiltInSubagentsEnabled()
        ? createSubagentTeamHost(controller, { getContext: () => sessionContext })
        : createUnavailableTeamHost();
    pi.on("session_start", (_event, ctx) => {
      sessionContext = ctx;
    });
    createPiTeamExtension(pi as unknown as Parameters<typeof createPiTeamExtension>[0], host);
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

export interface PiExtensionBuiltinsOptions {
  /** 既有 subagent controller；缺省（子 agent 被关闭）时团队桥降级为不可派发。 */
  subagentController?: SubagentController;
  /** 测试用：只想要某个扩展时传名字集合。 */
  include?: readonly string[];
}

/** 返回三个 `builtin:` 扩展，顺序与 PI_EXTENSION_BUILTIN_NAMES 一致。 */
export function createPiExtensionBuiltins(options: PiExtensionBuiltinsOptions = {}): InlineExtension[] {
  const include = options.include ? new Set(options.include) : undefined;
  const wants = (name: string) => !include || include.has(name);
  return [
    ...(wants(LSP_BUILTIN_NAME) ? [lspBuiltin()] : []),
    ...(wants(TEAM_BUILTIN_NAME) ? [teamBuiltin(options.subagentController)] : []),
    ...(wants(PURGE_BUILTIN_NAME) ? [purgeBuiltin()] : []),
  ];
}

export { PI_EXTENSION_BUILTIN_NAMES } from "./pi-extension-names";
export type { PiExtensionBuiltinName } from "./pi-extension-names";
