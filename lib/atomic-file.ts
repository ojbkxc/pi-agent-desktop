import { randomUUID } from "crypto";
import { chmodSync, closeSync, fsyncSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

/**
 * Replace a file atomically without exposing credentials through default
 * process permissions. The caller must create the parent directory first.
 */
export function writePrivateFileAtomicSync(path: string, contents: string): void {
  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}-${randomUUID()}.tmp`);
  let operationFailed = false;

  try {
    writeFileSync(tempPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    renameSync(tempPath, path);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !operationFailed) {
        throw error;
      }
    }
  }
}

/**
 * Resolve what an atomic replacement has to swap: a symlinked file is replaced
 * at its target so the link survives (dotfiles setups link ~/.pi/agent files),
 * and the replacement keeps the original permission bits unless `mode` is given.
 */
function atomicTarget(path: string, mode?: number): { target: string; mode: number } {
  let target = path;
  let resolved = mode;
  try {
    target = realpathSync(path);
    resolved ??= statSync(target).mode & 0o7777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { target, mode: resolved ?? 0o644 };
}

/**
 * Replace a file the user owns (a session transcript, settings.json, a SKILL.md,
 * auth.json) so that a crash or a full disk leaves either the old text or the
 * new one, never a truncated file.
 */
export function replaceFileAtomicSync(path: string, contents: string, options: { mode?: number } = {}): void {
  const { target, mode } = atomicTarget(path, options.mode);
  const tempPath = join(dirname(target), `.${basename(target)}-${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
    chmodSync(tempPath, mode);
    renameSync(tempPath, target);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Never created, or already renamed.
    }
    throw error;
  }
}

/**
 * The streamed form of `replaceFileAtomicSync`, for a file too large to hold in
 * memory: `write(tempPath)` fills the replacement itself, one line at a time.
 * Every guarantee of the string form holds — the symlink's target is replaced
 * (the link survives), the original permission bits are kept, an fsync runs
 * before the swap so a crash cannot publish a truncated file, and any failure
 * unlinks the temp file. The temp is created "wx"/0600 before `write` runs, so
 * `write` must open it for appending (flag "r+") and never truncate it.
 */
export async function replaceFileAtomicStream(
  path: string,
  write: (tempPath: string) => Promise<void>,
  options: { mode?: number } = {},
): Promise<void> {
  const { target, mode } = atomicTarget(path, options.mode);
  const tempPath = join(dirname(target), `.${basename(target)}-${randomUUID()}.tmp`);
  closeSync(openSync(tempPath, "wx", 0o600));
  try {
    await write(tempPath);
    // The swap waits for the bytes to be on disk: a rename that survives a crash
    // must not name a truncated transcript.
    const fd = openSync(tempPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tempPath, mode);
    renameSync(tempPath, target);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Never created, or already unlinked.
    }
    throw error;
  }
}
