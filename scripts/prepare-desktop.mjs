import { access, chmod, copyFile, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { constants, existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopTargetTriple } from "./desktop-platform.mjs";
import { assertPayloadClean, findLocalConfigDirs, pruneLocalConfig } from "./packaged-payload.mjs";
import { piPackageDirNames } from "./pi-packages.mjs";
import { dedupeNestedPackages, externalPackageSpecifiers, findNestedPiScopePackages, stageCompletePackage, stageResolvedClosure } from "./stage-package.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopBuildDir = join(rootDir, ".next-desktop");
const standaloneDir = join(desktopBuildDir, "standalone");
const tauriTargetDir = join(rootDir, "src-tauri", "target");
const serverResourcesDir = join(rootDir, "src-tauri", "resources", "server");
const serverHelperDir = join(rootDir, "src-tauri", "resources", "Pi Agent Server.app");
const nodeResourcesDir = join(rootDir, "src-tauri", "resources", "node");

/**
 * 打包前清掉上一次构建留下的 payload 副本。
 *
 * 这是**不依赖 tracer 行为**的那一道闸：`outputFileTracingExcludes` 在 Windows 上不可信
 * （Next 把每条 exclude 当 `path.join(dir, exclude)` 交给 picomatch，盘符反斜杠被读成转义，
 * 于是每条都不匹配任何东西），所以直接用「先删、再断言」。
 *
 * cargo 缓存保留：只删放 payload 副本（或由它打出来的安装包）的目录。
 * `target/<profile>/resources` 是 `tauri build` 逐文件拷 `src-tauri/resources` 的目标，
 * 从不清理旧文件 —— 上一次构建的陈旧 chunk 会一路堆进安装包，所以必须从空目录开始。
 */
async function clearTracedBuildOutput() {
  const removed = [];
  const remove = async (path) => {
    await rm(path, { recursive: true, force: true });
    removed.push(relative(rootDir, path));
  };

  await remove(serverResourcesDir);
  await remove(serverHelperDir);
  await remove(nodeResourcesDir);

  const profiles = new Set(["debug", "release"]);
  const removeProfileOutput = async (dir) => {
    for (const name of ["resources", "bundle"]) {
      await remove(join(dir, name));
    }
  };

  let targetEntries = [];
  try {
    targetEntries = await readdir(tauriTargetDir, { withFileTypes: true });
  } catch {
    // 这个 checkout 还没跑过 `tauri build`。
  }
  for (const entry of targetEntries) {
    if (!entry.isDirectory()) continue;
    const full = join(tauriTargetDir, entry.name);
    if (profiles.has(entry.name)) {
      await removeProfileOutput(full);
      continue;
    }
    if (entry.name === "nsis") {
      // 安装包暂存目录内嵌整个 payload。
      await remove(full);
      continue;
    }
    // 交叉编译三元组：`target/<triple>/<profile>/…`。
    let tripleEntries = [];
    try {
      tripleEntries = await readdir(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const inner of tripleEntries) {
      if (inner.isDirectory() && profiles.has(inner.name)) {
        await removeProfileOutput(join(full, inner.name));
      }
    }
  }

  console.log(`Cleared previous build output: ${removed.length} path(s)`);
}

/**
 * CI canary for the payload assertion.
 *
 * A clean CI checkout has no `.pi/` (it is gitignored), so "the payload must not
 * carry a `.pi/`" would pass vacuously. With `PAYLOAD_CANARY=1` this script
 * plants a `.pi/mcp.json` holding a fake `Bearer ak_` token before the build,
 * reports whether the tracer picked it up, and fails if it survives into the
 * payload. A checkout that already has `.pi/mcp.json` is left alone. On exit
 * (including SIGINT/SIGTERM) only what this script created is removed: the file,
 * and the `.pi/` directory only if it did not exist before.
 */
const CANARY_DIR = join(rootDir, ".pi");
const CANARY_FILE = join(CANARY_DIR, "mcp.json");
const CANARY_TOKEN = "Bearer ak_PAYLOADCANARYNOTAREALKEY000000";

async function plantPayloadCanary() {
  if (process.env.PAYLOAD_CANARY !== "1") return false;
  if (existsSync(CANARY_FILE)) {
    console.log("Payload canary: this checkout already has .pi/mcp.json; scanning that instead of planting one");
    return false;
  }
  const createdDir = !existsSync(CANARY_DIR);
  await mkdir(CANARY_DIR, { recursive: true });
  await writeFile(
    CANARY_FILE,
    `${JSON.stringify(
      { mcpServers: { canary: { url: "http://127.0.0.1:1/entity/mcp", headers: { Authorization: CANARY_TOKEN } } } },
      null,
      2,
    )}\n`,
  );
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (createdDir) rmSync(CANARY_DIR, { recursive: true, force: true });
      else rmSync(CANARY_FILE, { force: true });
    } catch {
      // Best effort; the file holds no real credential.
    }
  };
  process.once("exit", cleanup);
  // Node does not emit `exit` for a default SIGINT/SIGTERM.
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.once(signal, () => {
      cleanup();
      process.exit(code);
    });
  }
  console.log("Payload canary: planted .pi/mcp.json (fake token) so the payload assertion has something to catch");
  return true;
}

async function runNextBuild() {
  const require = createRequire(import.meta.url);
  const nextBin = require.resolve("next/dist/bin/next", { paths: [rootDir] });

  await rm(desktopBuildDir, { recursive: true, force: true });

  // The packaged server leaks its runtime config into spawned process trees
  // via __NEXT_PRIVATE_STANDALONE_CONFIG; JSON drops function values, so an
  // inherited build dies on `generateBuildId`. Always load config fresh.
  const buildEnv = { ...process.env };
  delete buildEnv.__NEXT_PRIVATE_STANDALONE_CONFIG;
  delete buildEnv.__NEXT_PRIVATE_ORIGIN;

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [nextBin, "build", "--webpack"], {
      cwd: rootDir,
      env: {
        ...buildEnv,
        NEXT_TELEMETRY_DISABLED: "1",
        PI_WEB_DESKTOP_BUILD: "1",
      },
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Next.js desktop build failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

async function assembleServer() {
  await access(join(standaloneDir, "server.js"), constants.R_OK);
  await rm(serverResourcesDir, { recursive: true, force: true });
  await mkdir(dirname(serverResourcesDir), { recursive: true });
  await cp(standaloneDir, serverResourcesDir, { recursive: true });

  // Next's file tracer follows normal imports but intentionally omits files
  // reached through dynamic provider/export/plugin paths. These packages are
  // serverExternalPackages, so preserve their complete runtime `dist/` trees.
  // package.json rides along so dedupeNestedPackages() can read the top-level
  // version: without it a nested duplicate survives dedupe and ships (the
  // 0.4.7 installer shipped exactly that, #72).
  for (const packageName of await piPackageDirNames()) {
    const packageSource = join(rootDir, "node_modules", "@earendil-works", packageName);
    const packageDestination = join(
      serverResourcesDir,
      "node_modules",
      "@earendil-works",
      packageName,
    );
    await cp(join(packageSource, "dist"), join(packageDestination, "dist"), {
      recursive: true,
      force: true,
    });
    await copyFile(join(packageSource, "package.json"), join(packageDestination, "package.json"));
  }

  // node-pty loads its native binding through a runtime-computed path
  // (`prebuilds/${platform}-${arch}/*.node`), which Next's file tracer cannot
  // follow — the standalone output ships only lib/ and package.json. Copy the
  // full prebuilds tree (one signed build serves every platform it supports)
  // and restore the executable bit macOS strips from spawn-helper.
  const ptySource = join(rootDir, "node_modules", "node-pty");
  const ptyDestination = join(serverResourcesDir, "node_modules", "node-pty");
  // Windows starts its output worker and console-list helper by computed path.
  // The tracer omits both; copying native prebuilds alone still exits with -1.
  await cp(join(ptySource, "lib"), join(ptyDestination, "lib"), { recursive: true, force: true });
  const ptyPrebuildsSource = join(ptySource, "prebuilds");
  let ptyPrebuildsPresent = false;
  try {
    await access(ptyPrebuildsSource, constants.R_OK);
    ptyPrebuildsPresent = true;
  } catch {
    // node-pty without prebuilds (source build) — nothing to copy.
  }
  if (ptyPrebuildsPresent) {
    await cp(ptyPrebuildsSource, join(ptyDestination, "prebuilds"), { recursive: true, force: true });
    // macOS strips the executable bit from spawn-helper in every published
    // prebuild (fix once upstream preserves it). Fix all darwin variants so a
    // staged build works on either host architecture.
    for (const variant of ["darwin-arm64", "darwin-x64"]) {
      try {
        await chmod(join(ptyDestination, "prebuilds", variant, "spawn-helper"), 0o755);
      } catch {
        // variant not present in this checkout — nothing to fix.
      }
    }
  }

  // Next's file tracer drops files that a package loads through runtime
  // `require` / `import.meta.resolve`, so jiti and quickjs-wasi arrive
  // incomplete:
  //  - jiti: only lib/jiti-static.mjs survives, the pi-coding-agent bundle
  //    reaches lib/jiti.cjs only through a lazy require("jiti"), and extension
  //    loading fails with "Cannot find module .../jiti/lib/jiti.cjs".
  //  - quickjs-wasi: the sandbox loads "quickjs-wasi/quickjs.wasm" plus the
  //    extensions' *.so through `import.meta.resolve`; without them Code mode
  //    is off for every packaged session.
  // Ship each complete source package over every staged copy of it. Where that
  // copy lives depends on npm's layout (pi 1.0.0 nested quickjs-wasi under
  // pi-coding-agent, pi 1.0.1 hoists it for pi-codemode) and the dedupe pass
  // below deletes nested copies that match the top level, so see
  // stage-package.mjs before assuming a path. `npm run desktop:verify`
  // checks the result by running the packaged Code mode sandbox.
  const stagedNodeModulesDir = join(serverResourcesDir, "node_modules");
  const piCodingAgentModules = join(rootDir, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
  await stageCompletePackage({
    name: "jiti",
    sources: [join(rootDir, "node_modules", "jiti")],
    stagedNodeModulesDir,
  });
  await stageCompletePackage({
    name: "quickjs-wasi",
    sources: [join(piCodingAgentModules, "quickjs-wasi"), join(rootDir, "node_modules", "quickjs-wasi")],
    stagedNodeModulesDir,
  });

  // pi-ai loads Amazon Bedrock through a variable specifier
  // (`import(runtimeSpecifier)` in bedrock-converse-stream.lazy.js) so bundlers
  // cannot follow it into the Node-only AWS SDK. Next's file tracer is one of
  // those bundlers: the standalone server gets pi-ai's dist, but not
  // @aws-sdk/client-bedrock-runtime, and a packaged session on amazon-bedrock
  // dies with ERR_MODULE_NOT_FOUND at the first stream. Copy the closure Node
  // actually resolves from that entry. Nested copies have to stay nested —
  // pi-ai's https-proxy-agent is 9.1.0 because the hoisted one is 7.0.6.
  const bedrockEntry = join(
    rootDir,
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "dist",
    "api",
    "bedrock-converse-stream.js",
  );
  await stageResolvedClosure({
    importer: bedrockEntry,
    specifiers: await externalPackageSpecifiers(bedrockEntry, [
      "@aws-sdk/client-bedrock-runtime",
      "@smithy/node-http-handler",
      "http-proxy-agent",
      "https-proxy-agent",
    ]),
    sourceRoot: rootDir,
    stagedNodeModulesDir,
  });

  await copyFile(
    join(rootDir, "desktop", "server-launcher.cjs"),
    join(serverResourcesDir, "desktop-server.cjs"),
  );

  // 设置页的「下载 cloudflared」在打包版里要靠这个脚本：lib/public-access/install.ts
  // 用子进程调它（进程 cwd 就是本目录），由它下载 + 校验 sha256 并把二进制写进用户目录。
  // 不 stage 的话，点下载只会得到 Node 的 "Cannot find module …" —— 界面看起来像坏了
  // （曾经就是这个报错）。脚本只用 node 内建模块，直接原样拷贝即可。
  const cloudflaredScriptDir = join(serverResourcesDir, "scripts");
  await mkdir(cloudflaredScriptDir, { recursive: true });
  await copyFile(
    join(rootDir, "scripts", "prepare-cloudflared.mjs"),
    join(cloudflaredScriptDir, "prepare-cloudflared.mjs"),
  );

  // 随应用打包的内置技能（builtin-skills/）：服务端由 lib/builtin-skills.ts 按
  // `process.cwd()/builtin-skills` 找回，而打包版的服务端 cwd 就是本目录（Tauri 用
  // `.current_dir(resource_dir/resources/server)` 拉起）。这些是纯数据文件（md / py），
  // Next 的文件追踪（@vercel/nft）看不到运行期拼出来的路径，所以必须在这里显式拷进来；
  // 漏了这一步内置技能在打包版里会静默消失（dev / e2e 下 cwd 是仓库根，照样能看到，
  // 所以只有真机打包版才会暴露）。见 scripts/prepare-desktop-builtin-skills.test.mjs。
  await cp(join(rootDir, "builtin-skills"), join(serverResourcesDir, "builtin-skills"), {
    recursive: true,
  });

  // 可选技能包（optional-skills/redteam）：不参与自动加载，由技能面板的「安装」按需
  // 复制到用户技能根。同样靠 process.cwd() 找回，必须一并 stage；见
  // scripts/prepare-desktop-optional-skills.test.mjs。
  await cp(join(rootDir, "optional-skills"), join(serverResourcesDir, "optional-skills"), {
    recursive: true,
  });

  const staticSource = join(desktopBuildDir, "static");
  const staticDestination = join(serverResourcesDir, ".next-desktop", "static");
  await mkdir(dirname(staticDestination), { recursive: true });
  await cp(staticSource, staticDestination, { recursive: true });

  const publicDir = join(rootDir, "public");
  try {
    await access(publicDir, constants.R_OK);
    await cp(publicDir, join(serverResourcesDir, "public"), { recursive: true });
  } catch {
    // `public/` is optional in Next.js projects.
  }
}

/** Paths that would exceed Windows' MAX_PATH once staged on a runner. */
async function findOverlongPaths() {
  // Mirrors the checkout location on a windows-latest runner. Measured even on
  // macOS so a long path fails the build here instead of inside makensis.
  const windowsPrefix = "D:\\a\\pi-agent-desktop\\pi-agent-desktop\\src-tauri\\resources\\server";
  const overlong = [];

  async function walk(dir, relative) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}\\${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), childRelative);
        continue;
      }
      const full = `${windowsPrefix}\\${childRelative}`;
      if (full.length > 260) overlong.push({ length: full.length, path: childRelative });
    }
  }

  await walk(serverResourcesDir, "");
  return overlong;
}

async function findNpmSource() {
  const npmFromCurrentRun = process.env.npm_execpath
    ? dirname(dirname(process.env.npm_execpath))
    : null;
  const candidates = [
    npmFromCurrentRun,
    join(dirname(process.execPath), "node_modules", "npm"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(join(candidate, "bin", "npx-cli.js"), constants.R_OK);
      return candidate;
    } catch {
      // Try the next Node installation layout.
    }
  }

  throw new Error("Could not locate npm next to the bundled Node.js runtime.");
}

async function bundleNodeRuntime() {
  const triple = desktopTargetTriple();
  await rm(serverHelperDir, { recursive: true, force: true });
  await rm(nodeResourcesDir, { recursive: true, force: true });

  let binaryPath;
  if (process.platform === "darwin") {
    // Wrap Node in an LSBackgroundOnly .app so it does not appear in the Dock.
    // Info.plist uses the parent CFBundleIdentifier (com.abcwyc.pi-agent) so
    // macOS TCC SystemPolicyAppData grants persist across launches — a distinct
    // helper id re-prompts "access data from other apps" every cold start.
    const contentsDir = join(serverHelperDir, "Contents");
    binaryPath = join(contentsDir, "MacOS", "node");
    await mkdir(dirname(binaryPath), { recursive: true });
    await copyFile(process.execPath, binaryPath);
    await chmod(binaryPath, 0o755);
    await copyFile(
      join(rootDir, "desktop", "server-helper-Info.plist"),
      join(contentsDir, "Info.plist"),
    );
    // Stage npm inside the .app exactly like the other platforms stage it beside
    // `node`. `lib/node-cli.ts` looks for `<nodeDir>/node_modules/npm/bin/<name>-cli.js`;
    // with node at Contents/MacOS/node that resolves inside the bundle, so a
    // Finder-launched app (minimal PATH) still finds npm. Without it the lookup fell
    // through to a bare `npx`, and skill install / plugin update died with a bare ENOENT
    // that looks like a broken feature.
    await cp(
      await findNpmSource(),
      join(contentsDir, "MacOS", "node_modules", "npm"),
      { recursive: true },
    );
  } else {
    const executableName = process.platform === "win32" ? "node.exe" : "node";
    binaryPath = join(nodeResourcesDir, executableName);
    await mkdir(nodeResourcesDir, { recursive: true });
    await copyFile(process.execPath, binaryPath);
    await chmod(binaryPath, 0o755);
    await cp(
      await findNpmSource(),
      join(nodeResourcesDir, "node_modules", "npm"),
      { recursive: true },
    );
  }

  return { binaryPath, triple };
}

await clearTracedBuildOutput();
await clearTracedBuildOutput();
await plantPayloadCanary();
await runNextBuild();

// tracer 不可信（DEFECT-000089）：pi SDK 以 `join(cwd, ".pi", "mcp.json")` 解析项目配置，
// 而 nft 按构建目录求值这个默认值，于是每个 import SDK 的路由都会把本 checkout 的
// `.pi/mcp.json`（含真实 Bearer key）trace 进来。Windows 上没法用 exclude 排除，只能
// 追踪后删除，再断言——这样任何**其它**方式混进 payload 的东西仍然会让构建失败。
// CI canary（PAYLOAD_CANARY=1）顺带报告 tracer 到底有没有把 .pi/ 拉进 standalone。
if (process.env.PAYLOAD_CANARY === "1") {
  const traced = await findLocalConfigDirs(standaloneDir);
  console.log(
    traced.length > 0
      ? `Payload canary: the tracer DID pull .pi/ into the standalone (${traced.join(", ")}) — the prune below is what keeps it out of the package`
      : "Payload canary: the tracer no longer pulls .pi/ into the standalone (the assertion stays as belt-and-braces)",
  );
}
const pruned = await pruneLocalConfig(standaloneDir);
if (pruned.length > 0) {
  console.log(`Dropped ${pruned.length} traced local-config director${pruned.length === 1 ? "y" : "ies"}: ${pruned.join(", ")}`);
}
await assertPayloadClean(standaloneDir, { label: ".next-desktop/standalone" });

await assembleServer();

const deduped = await dedupeNestedPackages(serverResourcesDir);
if (deduped > 0) console.log(`Removed ${deduped} redundant nested package cop${deduped === 1 ? "y" : "ies"}`);

// #72 build gate: the app pins the whole @earendil-works scope to one version
// line, so the staged tree must never contain a pi package nested under
// another pi package. If one survives dedupe, shipping it breaks every
// Windows user on the next overwrite install (Node's nearest-module
// resolution loads the stale copy after the upgrade leaves it in place).
const nestedPiScope = await findNestedPiScopePackages(join(serverResourcesDir, "node_modules"));
if (nestedPiScope.length > 0) {
  console.error(
    `Staged node_modules contains @earendil-works packages nested under other @earendil-works packages:\n` +
      nestedPiScope.map((dir) => `  ${relative(rootDir, dir)}`).join("\n"),
  );
  throw new Error(
    "Refusing to package: a nested @earendil-works copy would shadow the top-level one after overwrite installs (#72).",
  );
}

// Fail here rather than inside makensis, which reports a bare "failed opening
// file" and takes an entire signed release build down with it.
const overlong = await findOverlongPaths();
if (overlong.length > 0) {
  console.error(
    `${overlong.length} staged path(s) exceed Windows' 260-character limit:\n` +
      overlong.map(({ length, path }) => `  ${length}  ${path}`).join("\n"),
  );
  throw new Error("Staged paths would break the Windows installer.");
}

const { binaryPath: nodeBinary, triple } = await bundleNodeRuntime();

// `tauri build` 之前的最后一道闸：staged payload 里不能带本 checkout 自己的配置或凭据。
await assertPayloadClean(join(rootDir, "src-tauri", "resources"), { label: "src-tauri/resources" });
console.log(`Desktop server staged at ${serverResourcesDir}`);
console.log(`Node runtime staged at ${nodeBinary} (${triple})`);
