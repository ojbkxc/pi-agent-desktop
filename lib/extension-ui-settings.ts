// 扩展面板的「默认永久允许」策略。
//
// 需求（操作者原话）：扩展弹出来的面板以后别再弹了，默认就是永久允许。
//
// 实现口径——只在**能确定「允许」是什么意思**的形态上自动作答：
// - `confirm`：允许 = `true`。这是扩展在问「可以吗」，答案是布尔，无需猜。
// - `select`：只有当某个选项文本明确表达允许（allow / yes / approve / 允许 / 是…）
//   时才自动选它。措辞里没有允许语义的 `select` 仍然弹出——替用户在一堆业务选项里
//   挑一个不是「允许」，那是**猜**，猜错的代价是扩展拿到它没被授权的结果。
// - `input`：不自动填。空串不是「允许」，是「什么都没说」。
// - `custom`（自绘面板）：没有可编程的答案，保持原样。
//
// 默认开启，但它是**显式可关**的设置（settings.json 的 `extensionUi.autoAllow`），
// 且每次自动作答都会写一行审计日志（method + title），事后可追溯「谁被自动放过了」。
// 自动作答不 emit UI 请求，前端因此不会弹窗、不会占住 pendingUiRequests，
// 那些「等对话框」的阻塞判据也就不会误判会话「在等人」。

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "./artifact-settings";

/** settings.json 里的容器键。 */
export const EXTENSION_UI_SETTINGS_KEY = "extensionUi";

/** 默认开启：操作者要的就是「别再弹」。 */
export const EXTENSION_UI_AUTO_ALLOW_DEFAULT = true;

/** 这些措辞表示「这是一个允许类选项」。 */
const ALLOW_OPTION_PATTERN = /^(?:allow|yes|ok|okay|approve|accept|continue|proceed|允许|同意|是|好|确定|确认|继续)/i;

export interface ExtensionUiSettings {
  autoAllow: boolean;
}

export function normalizeExtensionUiSettings(value: unknown): ExtensionUiSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { autoAllow: EXTENSION_UI_AUTO_ALLOW_DEFAULT };
  }
  const raw = (value as { autoAllow?: unknown }).autoAllow;
  return { autoAllow: typeof raw === "boolean" ? raw : EXTENSION_UI_AUTO_ALLOW_DEFAULT };
}

export function readExtensionUiSettings(
  settingsPath: string = getPiWebSettingsPath(),
): ExtensionUiSettings {
  try {
    return normalizeExtensionUiSettings(readStored(settingsPath)[EXTENSION_UI_SETTINGS_KEY]);
  } catch {
    // 文件坏了按「开着」处理：错在「多自动放行一次」比错在「又开始弹窗」更容易发现，
    // 而且每次放行都留了审计日志。
    return { autoAllow: EXTENSION_UI_AUTO_ALLOW_DEFAULT };
  }
}

export function writeExtensionUiAutoAllow(
  autoAllow: boolean,
  settingsPath: string = getPiWebSettingsPath(),
): ExtensionUiSettings {
  const next = normalizeExtensionUiSettings({ ...readExtensionUiSettings(settingsPath), autoAllow });
  updatePiWebSettings({ [EXTENSION_UI_SETTINGS_KEY]: next }, settingsPath);
  return next;
}

/** 会话侧调用：避开注入 agentDir 的测试与多 agent 目录。 */
export function extensionUiAutoAllowForAgentDir(agentDir: string = getAgentDir()): boolean {
  return readExtensionUiSettings(getPiWebSettingsPath(agentDir)).autoAllow;
}

/** 一条待答的扩展 UI 请求（只取判据需要的那几个字段）。 */
export interface ExtensionUiRequestLike {
  method?: unknown;
  title?: unknown;
  options?: unknown;
}

/**
 * `select` 里挑出「允许」那一项；没有明确的允许项就返回 undefined（调用方仍然弹出）。
 * `options` 在协议里既可能是字符串数组，也可能是 `{value,label}` 数组。
 */
export function pickAllowOption(options: unknown): string | undefined {
  if (!Array.isArray(options)) return undefined;
  for (const option of options) {
    if (typeof option === "string") {
      if (ALLOW_OPTION_PATTERN.test(option.trim())) return option;
      continue;
    }
    if (!option || typeof option !== "object") continue;
    const record = option as { value?: unknown; label?: unknown };
    const value = typeof record.value === "string" ? record.value : undefined;
    const label = typeof record.label === "string" ? record.label : undefined;
    // Judge by the **label** (what a human reads) and only fall back to the value:
    // an option's value is an opaque id like `a1`, which never says "allow".
    const probe = (label ?? value ?? "").trim();
    if (ALLOW_OPTION_PATTERN.test(probe)) return value ?? label;
  }
  return undefined;
}

/**
 * 该自动作答成什么；`undefined` 表示「这条仍然要弹给用户」。
 *
 * 口径（操作者两次明确要求「默认写死永久允许、别再弹」）：
 * - `confirm` → `true`。
 * - `select` → 优先选措辞明确是「允许」的那项；**没有**就取第一项——扩展给的选项集合就是
 *   它允许的答案域，取第一项等价于「默认接受」，比弹出来等一个人强。
 * - `input` / `editor` → 空串。空串是「没有额外信息」，不是取消（取消是 `undefined`）；
 *   对绝大多数「要不要继续 / 填个可选值」的提问，这正好是「继续，不附加条件」。
 * - `custom`（自绘面板）→ 不在这里处理：它没有可编程答案，由 `rpc-manager` 直接收起。
 *
 * 返回对象里的 `label` 只用于审计日志（例如选中了哪个选项）。
 */
export function autoAllowAnswer(
  request: ExtensionUiRequestLike,
): { kind: "confirm" } | { kind: "select"; label: string } | { kind: "text" } | undefined {
  const method = typeof request.method === "string" ? request.method : "";
  if (method === "confirm") return { kind: "confirm" };
  if (method === "select") {
    const label = pickAllowOption(request.options) ?? pickFirstOption(request.options);
    // 选项列表为空（扩展没给答案域）：仍然弹出，替它编一个值是瞎猜。
    return label === undefined ? undefined : { kind: "select", label };
  }
  if (method === "input" || method === "editor") return { kind: "text" };
  return undefined;
}

/** `select` 的兜底：没有明确「允许」项时取第一项（= 默认接受该扩展给的第一个答案）。 */
function pickFirstOption(options: unknown): string | undefined {
  if (!Array.isArray(options) || options.length === 0) return undefined;
  const first = options[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object") {
    const record = first as { value?: unknown; label?: unknown };
    if (typeof record.value === "string") return record.value;
    if (typeof record.label === "string") return record.label;
  }
  return undefined;
}
