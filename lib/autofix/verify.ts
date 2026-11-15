/**
 * 验证命令执行（server-only）：在本机跑用户/探测得到的 `verifyCommand`，
 * 收集 exit code 与输出尾部。exit code 0 = 「修好」——这是自动修 Bug 循环里
 * **唯一**的通过判据（模型自称修好了不算数）。
 *
 * 安全边界说明：命令来自用户输入（UI 里可改），与本机终端等价的本地执行能力；
 * 路由层负责「只接受本机受信请求」与长度上限。超时会杀子进程，输出只保留尾部。
 */
import { spawn } from "node:child_process";
import { AUTOFIX_OUTPUT_TAIL_MAX_CHARS, AUTOFIX_VERIFY_TIMEOUT_MS, tailOf } from "./types";

export interface VerifyOutcome {
  exitCode: number | null;
  timedOut: boolean;
  outputTail: string;
  durationMs: number;
}

export interface VerifyOptions {
  timeoutMs?: number;
  maxTailChars?: number;
  /** 测试缝：替换 child_process.spawn。 */
  spawnFn?: typeof spawn;
}

export function runVerifyCommand(
  command: string,
  cwd: string,
  options: VerifyOptions = {},
): Promise<VerifyOutcome> {
  const timeoutMs = options.timeoutMs ?? AUTOFIX_VERIFY_TIMEOUT_MS;
  const maxTailChars = options.maxTailChars ?? AUTOFIX_OUTPUT_TAIL_MAX_CHARS;
  const spawnFn = options.spawnFn ?? spawn;
  const startedAt = Date.now();

  return new Promise<VerifyOutcome>((resolve) => {
    let settled = false;
    let timedOut = false;
    let buffer = "";
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (exitCode: number | null, extra = ""): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const text = extra ? `${buffer}\n${extra}` : buffer;
      resolve({
        exitCode: timedOut ? null : exitCode,
        timedOut,
        outputTail: tailOf(text, maxTailChars),
        durationMs: Date.now() - startedAt,
      });
    };

    const append = (chunk: Buffer | string): void => {
      buffer += String(chunk);
      // 输出可能非常大（构建日志）；保留两倍窗口，收尾时再 tailOf。
      if (buffer.length > maxTailChars * 2) buffer = buffer.slice(buffer.length - maxTailChars * 2);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // already gone
      }
      // SIGTERM 可能被忽略（Windows 尤其）；再兜底一次强杀，然后收尾。
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        finish(null);
      }, 5_000);
    }, timeoutMs);
    // Deliberately NOT unref'd: if the only handle left is this timer (a child
    // that spawned but holds no pipes), the timeout must still fire and kill it.

    let child: ReturnType<typeof spawnFn>;
    try {
      child = spawnFn(command, {
        cwd,
        shell: true,
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error));
      return;
    }

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => finish(null, error instanceof Error ? error.message : String(error)));
    child.on("close", (code) => finish(code));
    // 子进程被信号杀死时 close 的 code 为 null；signal 名称不影响判据（非 0 即失败）。
  });
}
