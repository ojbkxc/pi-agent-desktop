// `npm run prepare:cloudflared` / `node scripts/prepare-cloudflared.mjs`:
// download the pinned cloudflared release for this platform, verify its SHA256 and
// stage it under vendor/cloudflared/ for lib/public-access/binary.ts to find.
//
// The digest table is copied from cc-haha (desktop/scripts/prepare-cloudflared.ts);
// a mismatch aborts the write, so a tampered or truncated download never reaches the
// tunnel. Nothing is fetched at runtime unless the user presses "download" in Settings.
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const CLOUDFLARED_VERSION = "2026.10.6";

/** name = the GitHub release asset; archive = needs untar; windowsAllowsX64Emulation for arm64. */
export const CLOUDFLARED_ASSETS = {
  "x86_64-apple-darwin": { name: "cloudflared-darwin-amd64.tgz", sha256: "6c04a13835ca5ff29a0c6f58d17d1f3956aad1b7df1631f5b5efbc06269deded", archive: true },
  "aarch64-apple-darwin": { name: "cloudflared-darwin-arm64.tgz", sha256: "ea1e5105d35bbe16cee5b2f7b4742059ada341fbd35938ed827c24b85efa51c8", archive: true },
  "x86_64-unknown-linux-gnu": { name: "cloudflared-linux-amd64", sha256: "1d356dac769d0dbf62ebe588c4034824bbff98d5790c2f844cc99e0e2f57462d", archive: false },
  "aarch64-unknown-linux-gnu": { name: "cloudflared-linux-arm64", sha256: "0ae0e179475b2c77651a718d2b376e0151f4fca5954702a84f02843a4d5fcac0", archive: false },
  "x86_64-pc-windows-msvc": { name: "cloudflared-windows-amd64.exe", sha256: "d521b3bf68982165f0d06d76732f22d9a105ef057ff3ae4c0986f3a23190950f", archive: false },
  // Cloudflare publishes no native Windows ARM64 build; Windows 11 ARM runs the x64 one.
  "aarch64-pc-windows-msvc": { name: "cloudflared-windows-amd64.exe", sha256: "d521b3bf68982165f0d06d76732f22d9a105ef057ff3ae4c0986f3a23190950f", archive: false },
};

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export function cloudflaredTargetTriple(platform = process.platform, arch = process.arch) {
  if (platform === "win32") return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  if (platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
}

export function getCloudflaredAsset(targetTriple, table = CLOUDFLARED_ASSETS) {
  const asset = table[targetTriple];
  if (!asset) throw new Error(`Unsupported target triple: ${targetTriple}`);
  return { ...asset };
}

export function getCloudflaredDownloadUrl(targetTriple, table = CLOUDFLARED_ASSETS) {
  return `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${getCloudflaredAsset(targetTriple, table).name}`;
}

export function bundledCloudflaredName(targetTriple, table = CLOUDFLARED_ASSETS) {
  getCloudflaredAsset(targetTriple, table);
  return `cloudflared-${targetTriple}${targetTriple.includes("windows") ? ".exe" : ""}`;
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Where the prepared binary lives: `<root>/vendor/cloudflared/`. */
export function cloudflaredDir(root = join(dirname(fileURLToPath(import.meta.url)), "..")) {
  return join(root, "vendor", "cloudflared");
}

const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];

function proxyUrlFrom(env) {
  return PROXY_ENV_KEYS.map((key) => env[key]).find((value) => typeof value === "string" && value.trim())?.trim();
}

/**
 * Node's fetch ignores the standard proxy variables, so on a network that needs a
 * proxy (the usual case on a corporate machine) the download would just hang.
 * Return a fetch bound to undici's ProxyAgent when a proxy is configured. The
 * dispatcher has to come from the same undici that performs the request — Node's
 * built-in fetch carries its own copy and rejects a foreign one — hence undici's
 * fetch here too. undici is a transitive dependency, so its absence is not fatal.
 */
export async function proxyFetch(env = process.env) {
  const url = proxyUrlFrom(env);
  if (!url) return undefined;
  try {
    const { ProxyAgent, fetch: undiciFetch } = await import("undici");
    const dispatcher = new ProxyAgent(url);
    return (input, init = {}) => undiciFetch(input, { ...init, dispatcher });
  } catch {
    return undefined;
  }
}

/** The ProxyAgent alone, for tests and diagnostics. */
export async function proxyDispatcher(env = process.env) {
  const url = proxyUrlFrom(env);
  if (!url) return undefined;
  try {
    const { ProxyAgent } = await import("undici");
    return new ProxyAgent(url);
  } catch {
    return undefined;
  }
}

async function readIfPresent(path) {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/** Reuse an already-staged, digest-correct binary instead of downloading again. */
async function alreadyPrepared(destination, asset) {
  const existing = await readIfPresent(destination);
  return existing !== null && sha256(existing) === asset.sha256 && !asset.archive;
}

function untarArchive(archivePath, directory) {
  // bsdtar ships with Windows 10+ and every macOS/Linux; no extra dependency.
  const result = spawnSync("tar", ["-xzf", archivePath, "-C", directory], { encoding: "utf8" });
  if (result.error) throw new Error(`Could not extract ${archivePath}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`tar exited ${result.status}: ${result.stderr?.trim() ?? ""}`);
}

/**
 * Download (or reuse) the pinned binary, verify its digest and write it atomically.
 * Returns { path, source: "cache" | "download" }.
 */
export async function prepareCloudflared(options = {}) {
  const targetTriple = options.targetTriple ?? cloudflaredTargetTriple();
  const table = options.assets ?? CLOUDFLARED_ASSETS;
  const asset = getCloudflaredAsset(targetTriple, table);
  const directory = options.directory ?? cloudflaredDir(options.root);
  const destination = join(directory, bundledCloudflaredName(targetTriple, table));
  const fetchImpl = options.fetch ?? await proxyFetch() ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;

  if (options.reuse !== false && await alreadyPrepared(destination, asset)) {
    return { path: destination, source: "cache" };
  }
  if (typeof fetchImpl !== "function") throw new Error("No fetch implementation available to download cloudflared");

  await mkdir(directory, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), "pi-web-cloudflared-"));
  try {
    const downloaded = join(scratch, asset.name);
    const response = await fetchImpl(getCloudflaredDownloadUrl(targetTriple, table), {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error) => {
      // Surface the underlying cause: "fetch failed" alone is useless for a proxy.
      throw new Error(`Could not download ${asset.name}: ${error?.cause?.message ?? error?.message ?? error}`);
    });
    if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = sha256(bytes);
    if (digest !== asset.sha256) {
      throw new Error(`Checksum mismatch for ${asset.name}: expected ${asset.sha256}, got ${digest}`);
    }
    await writeFile(downloaded, bytes);

    let staged = downloaded;
    if (asset.archive) {
      untarArchive(downloaded, scratch);
      staged = join(scratch, "cloudflared");
      const extracted = await readIfPresent(staged);
      if (!extracted) throw new Error(`Archive ${asset.name} did not contain a cloudflared binary`);
    }
    // Write beside the target and rename, so a partial file is never picked up.
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, await readFile(staged));
    chmodSync(temporary, 0o755);
    renameSync(temporary, destination);
    writeFileSync(
      `${destination}.json`,
      JSON.stringify({ version: CLOUDFLARED_VERSION, targetTriple, asset: asset.name, assetSha256: asset.sha256, binarySha256: sha256(readFileSync(destination)) }, null, 2),
    );
    return { path: destination, source: "download" };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Fail loudly at build/packaging time when the staged binary is missing or wrong. */
export async function assertPreparedCloudflared(targetTriple = cloudflaredTargetTriple(), directory = cloudflaredDir(), table = CLOUDFLARED_ASSETS) {
  const asset = getCloudflaredAsset(targetTriple, table);
  const path = join(directory, bundledCloudflaredName(targetTriple, table));
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`cloudflared is not prepared at ${path}; run npm run prepare:cloudflared`);
  const digest = sha256(await readFile(path));
  if (digest !== asset.sha256) throw new Error(`cloudflared at ${path} does not match the pinned digest`);
  return path;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const tripleIndex = args.indexOf("--triple");
  const triple = tripleIndex >= 0 ? args[tripleIndex + 1] : undefined;
  const dirIndex = args.indexOf("--dir");
  const directory = dirIndex >= 0 ? args[dirIndex + 1] : undefined;
  try {
    const result = await prepareCloudflared({ targetTriple: triple, directory });
    console.log(`cloudflared ready (${result.source}): ${result.path}`);
  } catch (error) {
    console.error(`[prepare-cloudflared] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
