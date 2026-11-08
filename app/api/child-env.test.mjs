import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// The two remaining server-side child processes that used a bare
// `{ ...process.env }`: file-index's read-only `git ls-files` and the session
// export's pi CLI. Same leak class as d2-1, lower impact — but they go through
// the one `childProcessEnvironment()` builder now, so the assert pins that
// call rather than re-deriving the sanitizer's math (which
// lib/project-command-env.test.mjs already covers).

const { childProcessEnvironment } = await createJiti(import.meta.url).import(
  "../../../lib/project-command-env.ts",
);

const SECRETS = {
  PI_WEB_PASSWORD: "web-login-password",
  PI_DESKTOP_API_TOKEN: "desktop-filesystem-credential",
  PI_DESKTOP_INSTANCE_ID: "instance-probe",
};

function withSecrets(run) {
  const original = {};
  for (const [name, value] of Object.entries(SECRETS)) {
    original[name] = process.env[name];
    process.env[name] = value;
  }
  try {
    return run();
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("file-index's git subprocess env carries no host secret", () => {
  withSecrets(() => {
    // The exact env the route passes to execFile("git", ["-C", cwd, …]).
    const environment = childProcessEnvironment({ LC_ALL: "C" });
    assert.equal(environment.PI_WEB_PASSWORD, undefined);
    assert.equal(environment.PI_DESKTOP_API_TOKEN, undefined);
    assert.equal(environment.PI_DESKTOP_INSTANCE_ID, undefined);
    // The locale pin survives: error-text matching in callers relies on it.
    assert.equal(environment.LC_ALL, "C");
  });
});

test("the session export CLI env carries no host secret and keeps its own flags", () => {
  withSecrets(() => {
    // The exact env the route passes to execFile(process.execPath, [cliPath,
    // "--export", …]). PI_OFFLINE blocks the CLI's network version check from
    // hanging the 30s timeout; PI_SKIP_VERSION_CHECK is the belt to that.
    const environment = childProcessEnvironment({
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    });
    assert.equal(environment.PI_WEB_PASSWORD, undefined);
    assert.equal(environment.PI_DESKTOP_API_TOKEN, undefined);
    assert.equal(environment.PI_DESKTOP_INSTANCE_ID, undefined);
    assert.equal(environment.PI_OFFLINE, "1");
    assert.equal(environment.PI_SKIP_VERSION_CHECK, "1");
  });
});
