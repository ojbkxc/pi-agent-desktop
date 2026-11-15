/**
 * 验证命令探测：没显式给 `verifyCommand` 时，从目标目录的 package.json 里挑一个
 * 最有「通过/失败」语义的脚本。
 *
 * 顺序：test → typecheck → check → lint。都没有就返回 null（调用方把它当校验错误，
 * 因为本功能的核心判据就是「验证命令 exit 0」，没有判据的自动修 Bug 没有意义）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT_CANDIDATES: ReadonlyArray<readonly [script: string, label: string]> = [
  ["test", "npm test"],
  ["typecheck", "npm run typecheck"],
  ["check", "npm run check"],
  ["lint", "npm run lint"],
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 纯函数：从已解析的 package.json 内容里挑验证命令。 */
export function detectVerifyCommandFromPackage(pkg: unknown): string | null {
  if (!isRecord(pkg) || !isRecord(pkg.scripts)) return null;
  for (const [script, command] of SCRIPT_CANDIDATES) {
    const value = pkg.scripts[script];
    if (typeof value === "string" && value.trim()) return command;
  }
  return null;
}

/** 读 `<cwd>/package.json` 探测；读不到/坏 JSON 一律 null。 */
export function detectVerifyCommand(cwd: string): string | null {
  try {
    return detectVerifyCommandFromPackage(JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")));
  } catch {
    return null;
  }
}
