import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { resolveJobShell } = await jiti.import("./shell.ts");

/** 一个总是找不到 bash 的 SDK 桩，模拟干净的 Windows 装机。 */
function noBash() {
  throw new Error("No bash shell found. Options:\n  1. Install Git for Windows");
}

function probes(overrides = {}) {
  return {
    platform: "win32",
    sdkShell: () => ({ shell: "/usr/bin/bash", args: ["-c"] }),
    bashPath: () => null,
    powershell: () => ({ shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: ["-NoProfile", "-Command"] }),
    ...overrides,
  };
}

test("SDK 找到 bash 时原样使用，且不标记降级", () => {
  const config = resolveJobShell(probes());
  assert.deepEqual(config, { shell: "/usr/bin/bash", args: ["-c"], degraded: false });
});

test("SDK 找不到 bash、本仓库探测器找到时也用它，不算降级", () => {
  const config = resolveJobShell(probes({ sdkShell: noBash, bashPath: () => "D:\\Program Files\\Git\\bin\\bash.exe" }));
  assert.equal(config.shell, "D:\\Program Files\\Git\\bin\\bash.exe");
  assert.deepEqual(config.args, ["-c"]);
  assert.equal(config.degraded, false);
});

test("Windows 上都没有 bash 时退回 PowerShell，并说明降级原因", () => {
  const config = resolveJobShell(probes({ sdkShell: noBash, bashPath: () => null }));
  assert.equal(config.shell, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  assert.equal(config.degraded, true);
  assert.match(config.reason, /No bash shell found/);
  assert.match(config.reason, /PowerShell/);
});

test("PowerShell 也拿不到时仍然给出一条能 spawn 的命令，而不是抛错", () => {
  const config = resolveJobShell(probes({
    sdkShell: noBash,
    bashPath: () => null,
    powershell: () => { throw new Error("No PowerShell executable found"); },
  }));
  assert.equal(config.shell, "powershell.exe");
  assert.deepEqual(config.args, ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(config.degraded, true);
});

test("Unix 上 SDK 自己就有 sh 兜底；它要是抛了，这里退回 sh -c", () => {
  const config = resolveJobShell(probes({ platform: "linux", sdkShell: noBash, bashPath: () => null }));
  assert.deepEqual(config, { shell: "sh", args: ["-c"], degraded: true, reason: "No bash shell found. Options:" });
});

test("探测器自己抛异常等同于没探测到，不向上冒泡", () => {
  const config = resolveJobShell(probes({
    sdkShell: noBash,
    bashPath: () => { throw new Error("settings unreadable"); },
  }));
  assert.equal(config.degraded, true);
  assert.match(config.shell, /pwsh\.exe$/);
});
