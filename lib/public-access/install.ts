/**
 * 设置页的「下载 cloudflared」动作。
 *
 * 下载与校验的逻辑留在 scripts/prepare-cloudflared.mjs（同一份 digest 表只存一处），
 * 这里以子进程方式调用它 —— 与 lib/npx.ts 的做法一致，避免把那个纯脚本打进服务端 bundle。
 */
import { execFile } from "node:child_process";
import { join } from "node:path";

/** 下载可能慢，给足时间；这是本机用户主动触发的动作。 */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

export interface CloudflaredInstallResult {
  ok: boolean;
  /** 面向用户的简短说明（成功或失败原因）。 */
  message: string;
}

export function cloudflaredInstallScript(cwd = process.cwd()): string {
  return join(cwd, "scripts", "prepare-cloudflared.mjs");
}

export async function installCloudflared(cwd = process.cwd()): Promise<CloudflaredInstallResult> {
  const script = cloudflaredInstallScript(cwd);
  return new Promise((resolve) => {
    execFile(process.execPath, [script], { cwd, timeout: INSTALL_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, message: (stderr || error.message).trim().slice(0, 500) || "download failed" });
        return;
      }
      resolve({ ok: true, message: stdout.trim().slice(0, 500) || "cloudflared ready" });
    });
  });
}
