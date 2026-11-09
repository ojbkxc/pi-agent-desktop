import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 打包版「下载 cloudflared」的打包哨兵。
 *
 * 背景：桌面壳把服务端放进 `src-tauri/resources/server/` 后，进程 cwd 就是那里；
 * lib/public-access/install.ts 只在 `cwd/scripts/prepare-cloudflared.mjs`（与上一级）
 * 找脚本。scripts/prepare-desktop.mjs 若不把该脚本 stage 进去，点「下载」只会得到
 * Node 的 "Cannot find module …"（界面看起来像功能坏了）。这是曾经真实发生的回归，
 * 所以用静态断言把它钉死：改打包脚本的人不能悄悄删掉这段 copy。
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readText = async (path) => (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
/**
 * 去掉整行 `//` 注释再做断言：注释里提到文件名不算数，必须是真代码。
 * ⚠️ 不能粗暴剥块注释：打包脚本里有形如 `**` 加 `/*` 的 glob 字面量，正则会把它
 * 当成块注释起点一路吞到下一个结束符，把要断言的代码整段吃掉（本哨兵第一版就踩过）。
 */
const stripLineComments = (source) => source.replace(/^\s*\/\/.*$/gm, "");

const prepareDesktop = await readText(join(root, "scripts", "prepare-desktop.mjs"));
const code = stripLineComments(prepareDesktop);

test("服务端资源的打包根是 src-tauri/resources/server", () => {
  // 这个常量决定了「cwd」在打包版里是什么；改了它，下面的相对路径推导全部失效。
  assert.match(prepareDesktop, /const serverResourcesDir = join\(rootDir, "src-tauri", "resources", "server"\)/);
});

test("prepare-desktop 把 prepare-cloudflared.mjs stage 进 server/scripts/", async () => {
  // 源脚本必须真实存在于仓库（否则 copyFile 会在打包时才炸）。
  await access(join(root, "scripts", "prepare-cloudflared.mjs"));

  // 目标目录：<serverResourcesDir>/scripts，且要先建目录（首次打包时不存在）。
  assert.match(code, /const cloudflaredScriptDir = join\(serverResourcesDir, "scripts"\)/);
  assert.match(code, /await mkdir\(cloudflaredScriptDir, \{ recursive: true \}\)/);

  // copyFile(<仓库>/scripts/prepare-cloudflared.mjs → <server>/scripts/prepare-cloudflared.mjs)。
  // 容错空白与尾逗号，但源/目标文件名必须都是 prepare-cloudflared.mjs。
  assert.match(
    code,
    /await copyFile\(\s*join\(rootDir, "scripts", "prepare-cloudflared\.mjs"\),\s*join\(cloudflaredScriptDir, "prepare-cloudflared\.mjs"\),?\s*\)/,
    "prepare-desktop.mjs 必须把 prepare-cloudflared.mjs 拷进 resources/server/scripts/",
  );
});

test("stage 的目标路径正好是 install.ts 在打包 cwd 下查找的第一个候选", async () => {
  // 跨文件契约：install.ts 的候选 = cwd/scripts/prepare-cloudflared.mjs；
  // 打包版 cwd = src-tauri/resources/server。两者必须对得上，否则一个拷了也找不到。
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { cloudflaredInstallScriptCandidates } = await jiti.import("../lib/public-access/install.ts");

  const packagedCwd = join(root, "src-tauri", "resources", "server");
  const stagedTarget = join(packagedCwd, "scripts", "prepare-cloudflared.mjs");
  const candidates = cloudflaredInstallScriptCandidates(packagedCwd, {});
  assert.equal(
    candidates[0],
    stagedTarget,
    "install.ts 在打包 cwd 下的第一候选必须等于 prepare-desktop 的 stage 目标",
  );
  // 无 env 覆盖时不应把仓库根路径混进打包候选（打包版没有那层目录）。
  assert.equal(candidates.length, 2);
});