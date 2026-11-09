/**
 * cloudflared 二进制的定位（服务端专用）。
 *
 * 查找顺序（第一个存在且可执行的胜出）：
 *   1. `PI_WEB_CLOUDFLARED` —— 显式绝对路径覆盖（打包/自托管要旁挂二进制时走这条）
 *   2. `~/.pi/agent/bin/cloudflared/<name>` —— 设置页「下载」的落点。放用户目录而不是
 *      仓库/打包目录：打包后的 resources 可能只读（macOS .app、Program Files），而且
 *      每次升级都会重建，装进去等于白装。
 *   3. `<cwd>/vendor/cloudflared/<name>` —— `npm run prepare:cloudflared` 的产物
 *   4. PATH 上的 `cloudflared`
 *
 * 找不到不抛错，返回 null，由调用方（隧道启动器 / 设置页）决定怎么提示。
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { userHome } from "../user-home.ts";

export type CloudflaredSource = "env" | "user" | "vendor" | "path";

export interface CloudflaredBinary {
  path: string;
  source: CloudflaredSource;
}

/** 与 cc-haha 的 sidecar 打包用同一套 target triple 命名。 */
export function cloudflaredTargetTriple(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === "win32") return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  if (platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
}

export function bundledCloudflaredName(
  triple = cloudflaredTargetTriple(),
  platform: NodeJS.Platform = process.platform,
): string {
  void platform;
  return `cloudflared-${triple}${triple.includes("windows") ? ".exe" : ""}`;
}

/** 项目内 vendor 目录（prepare-cloudflared.mjs 的落点）。 */
export function vendorCloudflaredDir(cwd = process.cwd()): string {
  return join(cwd, "vendor", "cloudflared");
}

/**
 * 设置页「下载」的落点：用户目录下（`PI_AGENT_HOME` 可覆盖，见 lib/user-home.ts）。
 * 与 `vendorCloudflaredDir` 分开，是为了让打包后的桌面端也能装、且升级后还在。
 */
export function userCloudflaredDir(): string {
  return join(userHome(), ".pi", "agent", "bin", "cloudflared");
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const raw = env.PATH ?? env.Path ?? env.path ?? "";
  for (const dir of raw.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export function resolveCloudflaredBinary(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): CloudflaredBinary | null {
  const name = bundledCloudflaredName(cloudflaredTargetTriple(platform), platform);

  const override = env.PI_WEB_CLOUDFLARED?.trim();
  if (override) {
    const candidate = isAbsolute(override) ? override : join(cwd, override);
    if (isExecutableFile(candidate)) return { path: candidate, source: "env" };
  }

  const userDir = join(userCloudflaredDir(), name);
  if (isExecutableFile(userDir)) return { path: userDir, source: "user" };

  const vendored = join(vendorCloudflaredDir(cwd), name);
  if (isExecutableFile(vendored)) return { path: vendored, source: "vendor" };

  const onPath = findOnPath(platform === "win32" ? "cloudflared.exe" : "cloudflared", env);
  if (onPath) return { path: onPath, source: "path" };

  return null;
}
