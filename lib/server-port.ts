/**
 * 服务器监听端口的持久化配置（服务端 + 启动器都读得到）。
 *
 * 与公网访问配置同在 `~/.pi/agent/pi-web/settings.json` 的 `serverPort` 键，但解析不依赖
 * pi SDK —— 启动器进程（bin/pi-web.js、scripts/lan-server.mjs）没有 SDK 可加载。
 *
 * 端口只在下次启动时生效：进程一旦 listen，改配置不会迁移正在服务的端口。
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { remoteAccessSettingsPath } from "./remote-access.ts";

export function isServerPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

function readStored(settingsPath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw new Error("Invalid Pi Web settings: expected an object");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/** 用户配置的端口；未配置或值非法时返回 null（调用方回退到默认端口）。 */
export function readConfiguredServerPort(
  env: NodeJS.ProcessEnv = process.env,
  settingsPath = remoteAccessSettingsPath(env),
): number | null {
  try {
    const value = readStored(settingsPath).serverPort;
    return isServerPort(value) ? value : null;
  } catch {
    return null;
  }
}

/** 保存端口，保留同一文件里的其它键；非法值抛错，避免把启动器带进坏状态。 */
export function writeConfiguredServerPort(
  port: number,
  settingsPath = remoteAccessSettingsPath(),
): number {
  if (!isServerPort(port)) throw new Error("serverPort must be an integer from 1024 to 65535");
  const stored = readStored(settingsPath);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify({ ...stored, version: 1, serverPort: port }, null, 2));
  return port;
}
