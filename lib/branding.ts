/**
 * Local product branding.
 *
 * Keep this separate from the upstream package/repository names so syncing a
 * newer agegr/pi-web release cannot silently change the user-facing brand.
 */
export const PRODUCT_NAME = "Pi Agent" as const;

import desktopPackage from "../src-tauri/pi-agent-desktop-package.json";

/** Name and version of this packaged desktop distribution. */
export const APP_DISTRIBUTION_NAME = "pi-agent-desktop" as const;
/**
 * The repository this build actually ships from.
 *
 * The fork publishes its own signed releases, so pointing these at upstream
 * would tell users a newer version exists that they cannot install — and would
 * break outright if upstream ever disappeared. `src-tauri/tauri.conf.json`'s
 * updater endpoint already names this fork; these must name the same place.
 */
export const APP_REPOSITORY = "ojbkxc/pi-agent-desktop" as const;
export const APP_REPOSITORY_URL = `https://github.com/${APP_REPOSITORY}` as const;
export const APP_RELEASES_URL = `${APP_REPOSITORY_URL}/releases` as const;
export const APP_VERSION = desktopPackage.version;
export const APP_VERSION_DISPLAY = APP_VERSION.endsWith(".0")
  ? APP_VERSION.slice(0, -2)
  : APP_VERSION;
