/**
 * 把 package-lock.json 里被 npm 改写的 git 源地址改回 https。
 *
 * 本仓的 `lsp-mcp` / `pi-team` / `pi-purge` 走 git 源依赖。某些 npm 版本在
 * `npm install` 之后会把 `resolved` 里的 `git+https://github.com/...` 重写成
 * `git+ssh://git@github.com/...`。CI runner 和绝大多数没有配置 SSH key 的贡献者
 * 都装不了这种地址，于是下一次 `npm ci` 直接失败。同步流程在每次 `npm install`
 * 之后跑一遍本脚本，把地址改回去；`release-workflows.test.mjs` 会断言提交进仓库的
 * lock 里不含 `git+ssh://`。
 *
 * CLI:
 *   node scripts/normalize-lock-git-urls.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { rootDir } from "./release-components.mjs";

const lockPath = join(rootDir, "package-lock.json");

/** 纯函数，便于单测：把 git+ssh 的 GitHub 地址统一改回 git+https。 */
export function normalizeLockGitUrls(text) {
  return text.replace(/git\+ssh:\/\/git@github\.com\//g, "git+https://github.com/");
}

async function main() {
  const original = await readFile(lockPath, "utf8");
  const normalized = normalizeLockGitUrls(original);
  if (normalized === original) {
    console.log("package-lock.json 的 git 地址已是 https，无需修改。");
    return;
  }
  await writeFile(lockPath, normalized);
  console.log("已把 package-lock.json 里的 git+ssh:// 地址改回 git+https://。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
