import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { discoverTerminalShells } from "./terminal-shells";
import { samePath } from "./paths";
import { readTerminalShellPreference } from "./terminal-settings";

/**
 * 让会话里的 `bash` 工具在这台 Windows 机器上找得到 bash。
 *
 * SDK 的 `getShellConfig()` 只查 `%ProgramFiles%\Git\bin\bash.exe`、`%ProgramFiles(x86)%\…`
 * 和 PATH 上的 `bash.exe`。本机（以及不少中文/自定义安装的 Windows）Git 装在别的盘
 * （这里是 `D:\Program Files\Git\bin\bash.exe`），`ProgramFiles` 又没被改写 —— 于是
 * 每条会话的 `bash` 工具都直接报 "No bash shell found"（2026-11-12 实测两处会话）。
 * 用户在设置里选过的终端（`pi-web/settings.json` 的 `terminalShell`）本来就知道路径，
 * 兜底拿它；没有再退回 `discoverTerminalShells()`（它按 `git.exe` 反查同一棵树）。
 *
 * **只读兜底**：SDK 已经配置了 `shellPath`（settings.json 用户明确设置）时绝不复写；
 * 只在 `process.platform === "win32"` 且探测到一个真实存在的 bash 时才生效。返回值是
 * 一个 SettingsManager Proxy —— 与 compaction 的包装同款：只覆盖 `getShellPath`，其余
 * 方法/属性直通并保持函数身份稳定。
 */
export function withWindowsBashFallback(base: SettingsManager, platform: NodeJS.Platform = process.platform): SettingsManager {
  if (platform !== "win32") return base;
  const configured = base.getShellPath();
  if (configured) return base;

  const detected = detectBashPath(platform);
  if (!detected) return base;

  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(base, {
    get(target, property) {
      if (property === "getShellPath") return () => detected;
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (!bound.has(property)) bound.set(property, value.bind(target));
      return bound.get(property);
    },
    set(target, property, value) {
      bound.delete(property);
      return Reflect.set(target, property, value, target);
    },
  });
}

/** 探测本机的 bash：优先用户选过的终端，其次终端发现器（按 git.exe 反查）。 */
export function detectBashPath(platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "win32") return null;
  const bashNames = /(?:^|[\\/])bash(?:\.exe)?$/i;
  // discoverTerminalShells 只用「可执行 + 存在的文件」入选，所以命中即真实可用。
  const { shells } = discoverTerminalShells({ platform });
  const preferred = readTerminalShellPreference();
  const chosen = shells.find((shell) => preferred && samePath(shell.path, preferred) && bashNames.test(shell.path));
  if (chosen) return chosen.path;
  return shells.find((shell) => bashNames.test(shell.path))?.path ?? null;
}