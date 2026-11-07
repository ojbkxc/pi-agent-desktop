import { getSessionEntries, resolveSessionPath } from "./session-reader";
export { isFilePathReferencedByEntries } from "./session-file-references-core";
import {
  isBashOutputPathReferencedByEntries,
  isFilePathReferencedByEntries,
  isValidSessionId,
} from "./session-file-references-core";

/**
 * A UNC device path (`//host/share/...`, `\\?\...`) must never earn read access
 * through a session reference: reaching a dead host makes the route's `statSync`
 * (and every read after it) block the event loop for the SMB timeout, stalling
 * all requests including health checks. These paths are only readable through
 * the regular allow-list.
 */
function isUncOrDevicePath(filePath: string): boolean {
  return filePath.startsWith("//") || filePath.startsWith("\\\\");
}

export async function isFilePathReferencedBySession(filePath: string, sessionId: string | null): Promise<boolean> {
  if (isUncOrDevicePath(filePath)) return false;
  if (!isValidSessionId(sessionId)) return false;
  try {
    const sessionPath = await resolveSessionPath(sessionId);
    if (!sessionPath) return false;
    return isFilePathReferencedByEntries(filePath, getSessionEntries(sessionPath));
  } catch {
    return false;
  }
}

export async function isBashOutputPathReferencedBySession(filePath: string, sessionId: string | null): Promise<boolean> {
  if (isUncOrDevicePath(filePath)) return false;
  if (!isValidSessionId(sessionId)) return false;
  try {
    const sessionPath = await resolveSessionPath(sessionId);
    if (!sessionPath) return false;
    return isBashOutputPathReferencedByEntries(filePath, getSessionEntries(sessionPath));
  } catch {
    return false;
  }
}
