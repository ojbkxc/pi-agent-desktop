import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "./artifact-settings";
import { PRESET_FULL } from "./tool-presets";

// 全局「极简档」，对齐 cc-haha 的 `agentProfile === "lean"`：把一次会话的上下文压到最小 ——
// 不加载扩展（因此没有 MCP、没有 codemode/tool-search、没有团队与 LSP 工具）、不加载技能、
// 不加载提示模板与主题、不读项目与全局上下文文件（AGENTS.md / CLAUDE.md 一类），工具只留
// 内置的编码工具。
//
// 这不是安全边界，只是一条省 token 的路子，所以：
//   - 真源在**服务端**（Pi Web 自己的 settings.json）。`startRpcSession` 每次开始都读它，
//     因此**重开一个已存在的会话也照样生效**；客户端没有镜像，设置面板直接读这个接口。
//   - 与 chat-only 的区别：chat-only 要求工具集**为空**且保留上下文文件（`lib/chat-only.ts`），
//     lean 是一个最小的**非空**工具集且不读上下文文件。两者判定不同，所以 lean 是独立档位，
//     不动 `SessionKind`（那会牵动 `lib/session-policy.ts` 的一堆精确断言）。

/** lean 档留下的工具：与普通会话的内置编码工具同一套，去掉其余一切。 */
export const LEAN_TOOL_NAMES: readonly string[] = [...PRESET_FULL];

/**
 * lean 档的 resourceLoader 选项。与 `CHAT_ONLY_RESOURCE_LOADER_OPTIONS` 的差别在于
 * `noContextFiles`：chat-only 要保留上下文文件，lean 正是要省掉它们。
 */
export const LEAN_RESOURCE_LOADER_OPTIONS = {
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
} as const;

export const LEAN_MODE_SETTINGS_KEY = "leanMode";

/**
 * 是否处于极简档。读不动文件就当作关：lean 会实质性地减掉能力，不能因为文件损坏
 * 就静默生效（对比 `isArtifactsPromptEnabled` 的失败方向，那一项坏了按开）。
 */
export function isLeanMode(settingsPath = getPiWebSettingsPath()): boolean {
  try {
    return readStored(settingsPath)[LEAN_MODE_SETTINGS_KEY] === true;
  } catch {
    return false;
  }
}

/** 只改这一个键，Pi Web 设置文件里的其它键原样保留。 */
export function writeLeanMode(enabled: boolean, settingsPath = getPiWebSettingsPath()): boolean {
  updatePiWebSettings({ [LEAN_MODE_SETTINGS_KEY]: enabled }, settingsPath);
  return isLeanMode(settingsPath);
}
