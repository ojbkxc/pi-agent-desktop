/**
 * cloudflared 二进制的定位（服务端专用）。
 *
 * 查找顺序（第一个存在且可执行的胜出）：
 *   1. `PI_WEB_CLOUDFLARED` —— 显式绝对路径覆盖
 *   2. `PI_DESKTOP_RESOURCE_DIR/cloudflared/<name>` —— 桌面壳注入的 resources 目录
 *   3. `<cwd>/vendor/cloudflared/<name>` —— scripts/prepare-cloudflared.mjs 的产物
 *   4. PATH 上的 `cloudflared`
 *
 * 找不到不抛错，返回 null，由调用方（隧道启动器 / 设置页）决定怎么提示。
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type CloudflaredSource = "env" | "desktop" | "vendor" | "path";

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

  const resourceDir = env.PI_DESKTOP_RESOURCE_DIR?.trim();
  if (resourceDir) {
    const candidate = join(resourceDir, "cloudflared", name);
    if (isExecutableFile(candidate)) return { path: candidate, source: "desktop" };
  }

  const vendored = join(vendorCloudflaredDir(cwd), name);
  if (isExecutableFile(vendored)) return { path: vendored, source: "vendor" };

  const onPath = findOnPath(platform === "win32" ? "cloudflared.exe" : "cloudflared", env);
  if (onPath) return { path: onPath, source: "path" };

  return null;
}
