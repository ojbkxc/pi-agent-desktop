/**
 * 设置页的「下载 cloudflared」动作。
 *
 * 下载与校验的逻辑留在 scripts/prepare-cloudflared.mjs（同一份 digest 表只存一处），
 * 这里以子进程方式调用它 —— 与 lib/npx.ts 的做法一致，避免把那个纯脚本打进服务端 bundle。
 *
 * 打包后的桌面端（Tauri `resources/server`）里，这个脚本由
 * scripts/prepare-desktop.mjs 一并 stage 进来，进程 cwd 就是服务端根目录；这里仍按
 * 「显式 env 覆盖 → cwd → cwd 的上一级」依次找 —— 找不到时明确回 `missing-script`，
 * **不要**把 Node 的 "Cannot find module …" 原样丢给界面（那正是打包版曾经的报错形态）。
 *
 * 二进制落到用户目录（`userCloudflaredDir()`）而不是打包目录：见 binary.ts 的查找顺序。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { userCloudflaredDir } from "./binary.ts";

/** 下载可能慢，给足时间；这是本机用户主动触发的动作。 */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/** 稳定分类，供界面本地化；`message` 只作为详情（放进 title，不外露成主文案）。 */
export type CloudflaredInstallCode = "ok" | "missing-script" | "download-failed";

export interface CloudflaredInstallResult {
  ok: boolean;
  /** 面向用户的简短说明（成功或失败原因）。 */
  message: string;
  code: CloudflaredInstallCode;
}

/** 脚本可能的位置：显式 env 覆盖 → 服务端根目录 → 上一级（仓库根跑 dev 时）。 */
export function cloudflaredInstallScriptCandidates(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const override = env.PI_WEB_CLOUDFLARED_SCRIPT?.trim();
  return [
    ...(override ? [override] : []),
    join(cwd, "scripts", "prepare-cloudflared.mjs"),
    join(cwd, "..", "scripts", "prepare-cloudflared.mjs"),
  ];
}

/** 第一个存在的脚本路径；都没有返回 null。 */
export function resolveCloudflaredInstallScript(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return cloudflaredInstallScriptCandidates(cwd, env).find((candidate) => existsSync(candidate)) ?? null;
}

export async function installCloudflared(cwd = process.cwd()): Promise<CloudflaredInstallResult> {
  const script = resolveCloudflaredInstallScript(cwd);
  if (!script) {
    return {
      ok: false,
      code: "missing-script",
      message: `prepare-cloudflared.mjs not found (looked in ${cloudflaredInstallScriptCandidates(cwd).join(", ")})`,
    };
  }
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, "--dir", userCloudflaredDir()],
      { cwd, timeout: INSTALL_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            code: "download-failed",
            message: (stderr || error.message).trim().slice(0, 500) || "download failed",
          });
          return;
        }
        resolve({ ok: true, code: "ok", message: stdout.trim().slice(0, 500) || "cloudflared ready" });
      },
    );
  });
}
