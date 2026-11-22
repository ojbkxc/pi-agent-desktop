/**
 * Fast mode's stored preference: the `fastMode` block of Pi Web's own settings
 * file (`<agentDir>/pi-web/settings.json`), the same file the artifacts and
 * agent-guide switches use. It is kept out of pi's `settings.json` because the
 * pi CLI reads that file and has no fast-mode panel.
 *
 * Default is `off`, and an unreadable file also reads as `off`: a wrong "on"
 * costs prompt bytes on every request, and this feature is opt-in by design.
 */
import { statSync } from "node:fs";
import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "../artifact-settings";
import {
  DEFAULT_FAST_MODE_PRESET,
  isFastModePreset,
  resolveFastModeConfig,
  type FastModeConfig,
  type FastModePreset,
} from "./guidance";

const FAST_MODE_SETTINGS_KEY = "fastMode";

export interface StoredFastMode {
  preset: FastModePreset;
  /** Per-switch overrides; unknown keys elsewhere in the file are preserved. */
  switches?: Record<string, boolean>;
}

function readBlock(settingsPath: string): Record<string, unknown> | undefined {
  const stored = readStored(settingsPath) as Record<string, unknown>;
  const block = stored[FAST_MODE_SETTINGS_KEY];
  if (block === undefined) return undefined;
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    throw new Error("Invalid Pi Web settings: fastMode must be an object");
  }
  return block as Record<string, unknown>;
}

/**
 * Read once per file version.
 *
 * `readFastModeConfig` runs inside `before_agent_start`, i.e. on every turn, on
 * the server's event loop. Reading and parsing the whole `pi-web/settings.json`
 * there is work nobody needs when the file has not changed: a `stat` is enough
 * to know. The cache is keyed by path + mtime + size, so a write from the API
 * route (same process) invalidates it immediately, and an external edit does too.
 */
let cachedConfig: { path: string; mtimeMs: number; size: number; config: FastModeConfig } | undefined;

/** The effective configuration for this request. Never throws. */
export function readFastModeConfig(settingsPath: string = getPiWebSettingsPath()): FastModeConfig {
  let stat;
  try {
    stat = statSync(settingsPath, { throwIfNoEntry: false });
  } catch {
    stat = undefined;
  }
  if (!stat) {
    cachedConfig = undefined;
    return resolveFastModeConfig(DEFAULT_FAST_MODE_PRESET);
  }
  if (
    cachedConfig
    && cachedConfig.path === settingsPath
    && cachedConfig.mtimeMs === stat.mtimeMs
    && cachedConfig.size === stat.size
  ) {
    return cachedConfig.config;
  }
  let block: Record<string, unknown> | undefined;
  try {
    block = readBlock(settingsPath);
  } catch {
    // A broken file must never break a turn — and must not be cached, or the next
    // read would keep serving the default after the user repairs it.
    cachedConfig = undefined;
    return resolveFastModeConfig(DEFAULT_FAST_MODE_PRESET);
  }
  const overrides = block?.switches;
  const config = resolveFastModeConfig(
    block?.preset,
    overrides && typeof overrides === "object" && !Array.isArray(overrides)
      ? (overrides as Record<string, unknown>)
      : undefined,
  );
  cachedConfig = { path: settingsPath, mtimeMs: stat.mtimeMs, size: stat.size, config };
  return config;
}

/** Persist a preset (and optional switch overrides), returning what was stored. */
export function writeFastModeConfig(
  next: StoredFastMode,
  settingsPath: string = getPiWebSettingsPath(),
): FastModeConfig {
  const block: StoredFastMode = { preset: next.preset };
  if (next.switches) block.switches = next.switches;
  updatePiWebSettings({ [FAST_MODE_SETTINGS_KEY]: block }, settingsPath);
  // Read-your-write: drop the cache before reading back, so a filesystem whose mtime
  // granularity hides the write (same tick, same size) cannot serve the old value.
  cachedConfig = undefined;
  return readFastModeConfig(settingsPath);
}



/**
 * Validate a PUT body. Throws a message a 400 can carry verbatim; never writes.
 * Accepted: `{ preset }`, `{ preset, switches }`, and `{ switches }` alone (each
 * override applied to the stored preset, so a UI toggle can send one switch).
 */
export function normalizeFastModePatch(body: unknown, current: FastModeConfig): StoredFastMode {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("body must be an object");
  }
  const { preset, switches } = body as { preset?: unknown; switches?: unknown };
  if (preset !== undefined && !isFastModePreset(preset)) {
    throw new Error('preset must be "off", "conservative" or "standard"');
  }
  const merged: Record<string, boolean> = {};
  if (switches !== undefined) {
    if (switches === null || typeof switches !== "object" || Array.isArray(switches)) {
      throw new Error("switches must be an object");
    }
    for (const [key, value] of Object.entries(switches as Record<string, unknown>)) {
      if (typeof value !== "boolean") throw new Error(`switches.${key} must be a boolean`);
      merged[key] = value;
    }
  }
  const next: StoredFastMode = { preset: preset ?? current.preset };
  // Overrides are stored only when the caller sent some: a preset-only patch must not
  // freeze the switches the old preset happened to resolve to (that would make
  // `{preset:"standard"}` land on four `false` overrides).
  if (switches !== undefined) {
    const base = resolveFastModeConfig(next.preset).switches;
    next.switches = { ...base, ...merged };
  }
  return next;
}
