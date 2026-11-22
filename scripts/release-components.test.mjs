import assert from "node:assert/strict";
import test from "node:test";
import {
  compareVersions,
  createComponentManifest,
  desktopRepository,
  desktopVersionProblems,
  isReleasePinValid,
  nextDesktopVersion,
  nextPatchVersion,
  normalizeVersion,
  readCargoLockVersion,
} from "./release-components.mjs";

test("normalizes GitHub release tags", () => {
  assert.equal(normalizeVersion("v0.81.1"), "0.81.1");
  assert.equal(normalizeVersion("0.7.17"), "0.7.17");
  assert.throws(() => normalizeVersion("latest"), /Invalid release version/);
});

test("compares stable and prerelease versions", () => {
  assert.equal(compareVersions("0.81.1", "0.81.0"), 1);
  assert.equal(compareVersions("0.81", "0.81.0"), 0);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.10"), 1);
});

test("bumps the patch version", () => {
  assert.equal(nextPatchVersion("v0.1.0"), "0.1.1");
  assert.equal(nextPatchVersion("1.2"), "1.2.1");
});

test("never reuses a released version, including a prerelease", () => {
  assert.equal(nextDesktopVersion("0.7.3", ["0.7.2", "0.7.3"]), "0.7.4");
  // 0.7.4 is prepared locally but not released yet: another sync keeps it.
  assert.equal(nextDesktopVersion("0.7.4", ["0.7.2", "0.7.3"]), "0.7.4");
  assert.equal(nextDesktopVersion("0.7.4", ["0.7.3", "0.7.4"]), "0.7.5");
  assert.equal(nextDesktopVersion("0.7.3", ["0.7.2", "0.7.3", "0.7.4-rc.1"]), "0.7.5");
});

test("only accepts explicit pins for the exact bundled component version", () => {
  assert.equal(isReleasePinValid({ version: "0.8.7", reason: "Fork compatibility review" }, "0.8.7"), true);
  assert.equal(isReleasePinValid({ version: "0.8.8", reason: "Wrong version" }, "0.8.7"), false);
  assert.equal(isReleasePinValid({ version: "0.8.7", reason: "" }, "0.8.7"), false);
});

test("reads the desktop crate version out of Cargo.lock, CRLF or not", () => {
  const lf = [
    '[[package]]',
    'name = "pi-agent-desktop"',
    'version = "0.8.7"',
    'dependencies = [',
    ' "tauri",',
    ']',
    '',
    '[[package]]',
    'name = "tauri"',
    'version = "2.12.1"',
  ].join("\n");
  assert.equal(readCargoLockVersion(lf), "0.8.7");
  // A Windows checkout with core.autocrlf hands us the same file with CRLF; a
  // bare `\n` in the pattern used to miss it silently.
  assert.equal(readCargoLockVersion(lf.replace(/\n/g, "\r\n")), "0.8.7");
  assert.equal(readCargoLockVersion(lf, "tauri"), "2.12.1");
  // The package version is only read from the block that names the package:
  // another crate called "desktop" must not satisfy it.
  assert.equal(readCargoLockVersion(lf, "pi-agent-desktop2"), null);
  assert.equal(readCargoLockVersion("[[package]]\nname = \"other\"\nversion = \"9.9.9\"\n"), null);
});

test("a desktop version must be carried by Cargo.toml, Cargo.lock and the Tauri pointer", () => {
  const consistent = {
    expected: "0.8.7",
    cargoManifestVersion: "0.8.7",
    cargoLockVersion: "0.8.7",
    tauriVersionSource: "pi-agent-desktop-package.json",
  };
  assert.deepEqual(desktopVersionProblems(consistent), []);

  for (const [key, value, needle] of [
    ["cargoManifestVersion", "0.9.0", "src-tauri/Cargo.toml"],
    ["cargoLockVersion", "0.9.0", "src-tauri/Cargo.lock"],
    ["cargoLockVersion", null, "missing"],
    // A literal version in tauri.conf.json means Tauri builds and signs a
    // version that neither the manifest nor Cargo knows about.
    ["tauriVersionSource", "0.8.7", "tauri.conf.json"],
  ]) {
    const problems = desktopVersionProblems({ ...consistent, [key]: value });
    assert.equal(problems.length, 1, `${key}=${value} must be rejected`);
    assert.match(problems[0], new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  // All of them at once, so a single run reports every carrier that drifted.
  assert.equal(
    desktopVersionProblems({
      expected: "0.8.7",
      cargoManifestVersion: "0.9.0",
      cargoLockVersion: "0.8.6",
      tauriVersionSource: "0.8.7",
    }).length,
    3,
  );
});

test("writes an auditable three-component manifest", () => {
  assert.deepEqual(
    createComponentManifest({ "pi-agent-desktop": "0.1.0", pi: "0.81.1", "pi-web": "0.7.17" }),
    {
      schemaVersion: 1,
      appVersion: "0.1.0",
      components: [
        { id: "pi-agent-desktop", repository: desktopRepository(), version: "0.1.0" },
        { id: "pi", repository: "earendil-works/pi", version: "0.81.1" },
        { id: "pi-web", repository: "agegr/pi-web", version: "0.7.17" },
      ],
    },
  );
});
