/**
 * 后台 job 用哪个 shell 跑命令。
 *
 * `runtime.ts` 以前直接调 SDK 的 `getShellConfig()`，在 Windows 上它只认
 * `%ProgramFiles%\Git\bin\bash.exe` / `%ProgramFiles(x86)%\…` / PATH 上的 `bash.exe`，
 * 找不到就抛 "No bash shell found"。后果不是「提示一下」而是后台任务在**整台机器上
 * 完全不可用**：没有 Git Bash 的 Windows（干净装机、Git 装在 D 盘、MSYS2 只装了
 * `usr\bin`）每次 startBackgroundJob 都直接抛错。
 *
 * 三级兜底，顺序固定：
 * 1. SDK 自己的判断（尊重 `shellPath`、PATH、常装路径）；
 * 2. 本仓库已有的 `detectBashPath()`（`lib/windows-bash-fallback.ts`：先用户选过的终端，
 *    再按 `git.exe` 反查同一棵树）——SDK 找不到但本机确实有 bash 时补上；
 * 3. Windows 退回 PowerShell（`pwsh.exe` → `powershell.exe`），Unix 退回 `sh -c`。
 *
 * 兜底不是静默降级：`degraded` 与 `reason` 会带出去，`runtime.ts` 打一行 warn，
 * 用户才知道为什么 `$?`、管道、`&&` 这些 bash 语法在他们的命令里可能不成立。
 */
import { getPowerShellConfig, getShellConfig } from "@earendil-works/pi-coding-agent";
import { detectBashPath } from "../windows-bash-fallback";

export interface JobShell {
  shell: string;
  args: string[];
  /**
   * `stdin`：命令要从标准输入喂进去（SDK 对旧版 WSL 的 `bash.exe` 用 `-s`）。
   * 忽略它会让这类环境里的 job 起来就等一个不会到来的脚本，永远 running。
   * `argv`（或缺失）= 命令已经在 `args` 里。
   */
  commandTransport?: "argv" | "stdin";
}

export interface JobShellResolution extends JobShell {
  /** true = 没找到 bash，退到了 PowerShell / sh。 */
  degraded: boolean;
  /** 降级原因（一句话，可直接进日志）；未降级时没有这个字段。 */
  reason?: string;
}

/** 探测型函数便于测试注入；默认就是真实实现。 */
export interface JobShellProbes {
  sdkShell?: () => JobShell;
  bashPath?: () => string | null;
  powershell?: () => JobShell;
  platform?: NodeJS.Platform;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

/**
 * 解析一次 job 的 shell。**永不抛**：所有探测都失败时返回 `sh -c`，让 spawn 自己去失败，
 * 这样错误仍然挂在「启动 job」这一步上（调用方拿得到 BackgroundJobError），而不是在
 * 解析 shell 时抛出一个没有上下文的 Error。
 */
export function resolveJobShell(probes: JobShellProbes = {}): JobShellResolution {
  const platform = probes.platform ?? process.platform;
  const sdkShell = probes.sdkShell ?? (() => getShellConfig());
  const bashPath = probes.bashPath ?? (() => detectBashPath(platform));
  const powershell = probes.powershell ?? (() => getPowerShellConfig());

  let sdkError: string;
  try {
    const config = sdkShell();
    if (config?.shell) return { ...config, degraded: false };
    sdkError = "getShellConfig() returned no shell";
  } catch (error) {
    sdkError = message(error);
  }

  // 第二级：本仓库的探测器（只在 Windows 上有意义，非 win32 平台它自己返回 null）。
  try {
    const detected = bashPath();
    if (detected) return { shell: detected, args: ["-c"], degraded: false };
  } catch {
    // 探测失败与「没探测到」等价：继续往下走。
  }

  // 第三级：平台默认 shell。
  if (platform === "win32") {
    try {
      const config = powershell();
      if (config?.shell) {
        return { ...config, degraded: true, reason: `${sdkError}；已退回 PowerShell，bash 语法（$?、&&、管道内建）不保证成立` };
      }
    } catch (error) {
      return {
        shell: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command"],
        degraded: true,
        reason: `${sdkError}；PowerShell 也没找到（${message(error)}），按 PATH 上的 powershell.exe 试`,
      };
    }
  }
  return { shell: "sh", args: ["-c"], degraded: true, reason: sdkError };
}
