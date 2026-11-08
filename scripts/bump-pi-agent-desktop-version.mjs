import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  desktopRepository,
  fetchRecentReleases,
  nextDesktopVersion,
  normalizeVersion,
  rootDir,
} from "./release-components.mjs";

const packagePath = join(rootDir, "src-tauri", "pi-agent-desktop-package.json");
const cargoPath = join(rootDir, "src-tauri", "Cargo.toml");
const lockPath = join(rootDir, "src-tauri", "Cargo.lock");
const desktopPackage = JSON.parse(await readFile(packagePath, "utf8"));
const current = normalizeVersion(desktopPackage.version);
// 解析「实际发布本版本的仓库」(GITHUB_REPOSITORY，带 fork 回退)，而不是硬编码的上游名：
// 即便上游仓库某天消失，本 fork 也要能算出自己的下一个版本号。
const released = await fetchRecentReleases(desktopRepository(), { allowMissing: true });
const next = nextDesktopVersion(current, released.map((release) => release.version));

desktopPackage.version = next;
await writeFile(packagePath, `${JSON.stringify(desktopPackage, null, 2)}\n`);

const cargo = await readFile(cargoPath, "utf8");
await writeFile(cargoPath, cargo.replace(/^(version\s*=\s*")[^"]+("\s*)$/m, `$1${next}$2`));

const lock = await readFile(lockPath, "utf8");
await writeFile(
  lockPath,
  // `\r?` matters: on Windows with core.autocrlf the working copy of Cargo.lock is
  // CRLF, and a bare `\n` in the pattern silently matches nothing — the bump then
  // leaves Cargo.lock on the old version while Cargo.toml moves on. The Cargo.toml
  // regex above is unaffected: its `\s*` already absorbs the CR.
  lock.replace(/(name = "pi-agent-desktop"\r?\nversion = ")[^"]+("\r?\n)/, `$1${next}$2`),
);
console.log(`pi-agent-desktop ${current} -> ${next}`);
