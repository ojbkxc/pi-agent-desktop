import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isCredentialPath } from "./credential-paths.ts";

// d2-2: /api/files' credential blocklist must also cover the other AI CLIs'
// plaintext token stores. Without them, a session whose cwd is the home
// directory lets one GET download Claude Code's OAuth credentials
// (`~/.claude/.credentials.json`) and Codex's auth file (`~/.codex/auth.json`)
// — the same leak the list's own comment says it exists to prevent.

test("the other AI CLIs' token stores are credential paths", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-web-credpaths-"));
  try {
    for (const store of [".claude", ".codex"]) {
      mkdirSync(join(home, store), { recursive: true });
      writeFileSync(join(home, store, "marker"), "x");
    }

    assert.equal(isCredentialPath(join(home, ".claude"), home), true);
    assert.equal(isCredentialPath(join(home, ".claude", ".credentials.json"), home), true);
    assert.equal(isCredentialPath(join(home, ".codex"), home), true);
    assert.equal(isCredentialPath(join(home, ".codex", "auth.json"), home), true);
    // Existing paths resolve through a link into the store; a missing path is
    // still judged lexically.
    assert.equal(isCredentialPath(join(home, ".claude", "missing.json"), home), true);

    // The pre-existing entries keep working.
    assert.equal(isCredentialPath(join(home, ".ssh", "id_rsa"), home), true);
    assert.equal(isCredentialPath(join(home, ".npmrc"), home), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("project files and unrelated home folders stay readable", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-web-credpaths-neg-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "pi-web-credpaths-else-"));
  try {
    mkdirSync(join(home, "myapp"), { recursive: true });
    writeFileSync(join(home, "myapp", ".env"), "DATABASE_URL=...");
    writeFileSync(join(home, "notes.txt"), "hello");

    assert.equal(isCredentialPath(join(home, "myapp"), home), false);
    assert.equal(isCredentialPath(join(home, "myapp", ".env"), home), false);
    assert.equal(isCredentialPath(join(home, "notes.txt"), home), false);
    // A name that merely contains a blocklisted word is not a blocklisted path…
    assert.equal(isCredentialPath(join(home, "myapp", ".claude-notes.md"), home), false);
    // …and the blocklist never applies outside the home directory.
    mkdirSync(join(elsewhere, ".claude"), { recursive: true });
    assert.equal(isCredentialPath(join(elsewhere, ".claude"), home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("Windows matching is case-insensitive", () => {
  // Default macOS and Windows volumes are case-insensitive, so `~/.CLAUDE`
  // must be refused there too; the comparison already folds case per-platform.
  const home = mkdtempSync(join(tmpdir(), "pi-web-credpaths-case-"));
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const expected = process.platform === "win32" || process.platform === "darwin";
    assert.equal(isCredentialPath(join(home, ".CLAUDE", "credentials.json"), home), expected);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
