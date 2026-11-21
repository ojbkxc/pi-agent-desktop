import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export async function linkDirectory(target, path) {
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

async function detectFileSymlinks() {
  if (process.platform !== "win32") return true;
  const probe = await mkdtemp(join(tmpdir(), "pi-web-link-probe-"));
  try {
    const target = join(probe, "target.txt");
    await writeFile(target, "probe");
    await symlink(target, join(probe, "link.txt"), "file");
    return true;
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

export const fileSymlinksAvailable = await detectFileSymlinks();
export const fileSymlinkSkip = fileSymlinksAvailable ? false
  : "Windows file symlinks require Developer Mode or the symlink privilege";

export async function assertOwnerOnlyMode(path, expected = 0o600) {
  const info = await stat(path);
  // Windows reports DOS attributes through mode; it does not implement POSIX permissions.
  if (process.platform !== "win32") assert.equal(info.mode & 0o777, expected);
  assert.ok(info.isFile());
}

/**
 * A path in its canonical long form, or resolved as given when it does not exist.
 * `realpathSync` alone keeps a Windows 8.3 short name (`C:\\Users\\EX_MAZ~1`);
 * the `.native` variant expands it, which is what makes the profile check below
 * read two spellings of one directory as the same tree.
 */
function canonicalPath(path) {
  for (const realpath of [realpathSync.native, realpathSync]) {
    try {
      return realpath(path);
    } catch {
      // Try the next form, then fall back to a plain resolve.
    }
  }
  return resolve(path);
}

export async function fixtureDir(prefix) {
  // Canonicalize both sides: Windows reports %TEMP% in its 8.3 short form
  // (`C:\Users\EX_MAZ~1\…`) while `homedir()` answers the long one, and
  // `relative()` reads those as two trees. The guard below then missed that
  // fixtures sit inside the profile, so trust tests inherited the developer's
  // ~/.pi and ~/.agents/skills through the SDK's ancestor scan and failed.
  const temp = canonicalPath(tmpdir());
  const relativeToHome = relative(canonicalPath(homedir()), temp);
  const inProfile = !relativeToHome.startsWith("..") && !isAbsolute(relativeToHome);
  // Ancestor-scanning trust tests must not inherit the developer's ~/.agents/skills.
  const base = inProfile ? resolve("test-results", "fixtures") : temp;
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, prefix));
}

const shellQuote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

let nativeBashDirectory;

export function useGitBashForTests(t) {
  if (process.platform !== "win32") return;
  if (!nativeBashDirectory) {
    const gitExec = execFileSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true }).trim();
    const bash = resolve(gitExec, "../../..", "bin/bash.exe");
    accessSync(bash);
    nativeBashDirectory = dirname(bash);
  }
  // Git installed outside Program Files is otherwise missed by the SDK,
  // which can select a WindowsApps WSL alias that cannot use Windows paths.
  const previous = process.env.PATH;
  process.env.PATH = `${nativeBashDirectory};${previous ?? ""}`;
  t.after(() => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  });
}

/** SDK !commands use a POSIX shell; Windows tests explicitly select native Git Bash. */
export function markerCommand(marker, output) {
  const code = `require('node:fs').writeFileSync(${JSON.stringify(marker.replaceAll("\\", "/"))}, 'ran');process.stdout.write(${JSON.stringify(output)})`;
  return `!${shellQuote(process.execPath.replaceAll("\\", "/"))} -e ${shellQuote(code)}`;
}
