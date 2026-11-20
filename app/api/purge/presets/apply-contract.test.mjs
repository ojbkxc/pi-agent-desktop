import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * Cross-boundary contract: the real `POST .../apply` response, fed into the real
 * `asPresetApplyResult` the panel uses.
 *
 * Both sides used to test their own assumption — the route asserted
 * `{ result, settings }`, the panel's parser required `{ applied }` — so a
 * *successful* disk write rendered as a failure and every test stayed green.
 * These assertions exist to make that specific mismatch impossible to ship.
 */

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-web-purge-preset-contract-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const serverJiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await serverJiti.import("./[id]/apply/route.ts");
const { BUILTIN_PRESETS } = await serverJiti.import("@/lib/purge/preset-catalog.ts");
const { writePurgeSettings } = await serverJiti.import("@/lib/purge-settings.ts");

// The panel module needs a JSX-aware loader; only its pure parser is used here.
const uiJiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const library = await uiJiti.import("@/components/PurgePresetLibrary.tsx");

after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

const PRESET = BUILTIN_PRESETS[0];

function apply(id, body) {
  const request = new Request(`http://localhost/api/purge/presets/${id}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ id }) });
}

/** A fresh, writable skill directory. */
function useSkillDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-preset-contract-skill-"));
  writePurgeSettings({ skill_dir: dir });
  return dir;
}

test("a skill_file apply the server calls a success is read as a success by the panel", async () => {
  const dir = useSkillDir();
  const response = await apply(PRESET.id, { target: "skill_file" });
  assert.equal(response.status, 200);

  const parsed = library.asPresetApplyResult(await response.json());
  assert.notEqual(parsed, null, "the panel must not treat a 200 apply response as a failure");
  assert.equal(parsed.applied.target, "skill_file");
  assert.equal(parsed.applied.path, join(dir, PRESET.id, "SKILL.md"));
  assert.equal(existsSync(parsed.applied.path), true, "the file the panel reports must exist");
});

test("a structured_template apply carries the template name the panel shows", async () => {
  useSkillDir();
  const response = await apply(PRESET.id, { target: "structured_template" });
  assert.equal(response.status, 200);

  const parsed = library.asPresetApplyResult(await response.json());
  assert.notEqual(parsed, null);
  assert.equal(parsed.applied.target, "structured_template");
  assert.equal(parsed.applied.name, PRESET.title);
  assert.equal(parsed.applied.path, null, "a template apply writes no file");
});

test("an error response is not read as a success", async () => {
  const response = await apply("definitely-not-a-preset", { target: "skill_file" });
  assert.equal(response.status, 404);
  assert.equal(library.asPresetApplyResult(await response.json()), null);
});
