"use strict";

// Launcher-side reader for the Settings-UI server port. Plain CJS on purpose:
// bin/pi-web.js and scripts/lan-server.mjs run before anything can import the
// TypeScript modules in lib/. Mirrors the path resolution in lib/remote-access.ts
// (PI_CODING_AGENT_DIR, then PI_AGENT_HOME, then the OS home directory).

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readFileSync } = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { homedir } = require("os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { join } = require("path");

function userHome() {
  return process.env.PI_AGENT_HOME || homedir();
}

function piWebSettingsPath(env = process.env) {
  const configured = typeof env.PI_CODING_AGENT_DIR === "string" ? env.PI_CODING_AGENT_DIR.trim() : "";
  const agentDir = configured
    ? configured === "~" || configured.startsWith("~/")
      ? join(userHome(), configured.slice(1))
      : configured
    : join(userHome(), ".pi", "agent");
  return join(agentDir, "pi-web", "settings.json");
}

function isServerPort(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

/**
 * The port saved from the Settings UI, or null when unset or unreadable.
 * Never throws: a broken settings file must not stop the server from starting.
 */
function readConfiguredServerPort(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(piWebSettingsPath(env), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return isServerPort(parsed.serverPort) ? parsed.serverPort : null;
  } catch {
    return null;
  }
}

module.exports = { readConfiguredServerPort, piWebSettingsPath };
