/**
 * 内置扩展名单：跨端 LSP 扩展、团队 agent 扩展（pi-team）、prompt 切换扩展（pi-purge）
 * 与目标模式扩展（pi-goal）。
 *
 * 这几个名字同时是 `builtin:<name>` 资源名（`-builtin:pi-lsp` / `-builtin:pi-team` /
 * `-builtin:pi-purge` / `-builtin:pi-goal` 在 `extensions` 设置里可关闭），也用于
 * `lib/builtin-extensions.ts` 的开关解析。单独放一个不 import 任何扩展包的模块，避免只想要
 * 名单的地方被迫加载扩展实现。
 *
 * 顺序有意义：`lib/builtin-extensions.ts` 用位置解构取前几个名字，新名字一律**追加在末尾**。
 */
export const PI_EXTENSION_BUILTIN_NAMES = ["pi-lsp", "pi-team", "pi-purge", "pi-goal"] as const;

export type PiExtensionBuiltinName = typeof PI_EXTENSION_BUILTIN_NAMES[number];
