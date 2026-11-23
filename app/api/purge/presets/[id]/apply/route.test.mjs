import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-web-purge-presets-apply-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");
const { BUILTIN_PRESETS } = await jiti.import("@/lib/purge/preset-catalog.ts");
const { readPurgeSettings, writePurgeSettings } = await jiti.import("@/lib/purge-settings.ts");

after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

const settingsPath = join(testAgentDir, "pi-web", "settings.json");
const PRESET = BUILTIN_PRESETS[0];

function postRequest(id, body, { contentType = "application/json", origin, host = "localhost" } = {}) {
  const headers = { "Content-Type": contentType, Host: host };
  if (origin) headers.Origin = origin;
  return new Request(`http://localhost/api/purge/presets/${id}/apply`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Call the handler exactly as Next does: a Request plus promised route params. */
function apply(id, body, options) {
  return POST(postRequest(id, body, options), { params: Promise.resolve({ id }) });
}

/** A fresh, writable skill directory for the tests that actually write files. */
function useSkillDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-preset-skill-"));
  writePurgeSettings({ skill_dir: dir });
  return dir;
}

test("POST rejects an untrusted caller with 403", async () => {
  useSkillDir();
  const response = await apply(PRESET.id, { target: "structured_template" }, {
    origin: "http://evil.example.com",
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error, "Untrusted API request");
});

test("POST rejects a non-JSON content type with 415", async () => {
  const response = await apply(PRESET.id, '{"target":"structured_template"}', {
    contentType: "text/plain",
  });
  assert.equal(response.status, 415);
  const body = await response.json();
  assert.equal(body.error, "Content-Type must be application/json");
});

test("POST rejects a broken or non-object body with 400", async () => {
  const invalid = await apply(PRESET.id, "{ not json");
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, "Invalid JSON body");

  for (const body of [JSON.stringify("nope"), JSON.stringify([1, 2, 3]), JSON.stringify(null)]) {
    const response = await apply(PRESET.id, body);
    assert.equal(response.status, 400, `body ${body} must be rejected`);
    assert.equal((await response.json()).error, "body must be a JSON object");
  }
});

test("POST rejects an unknown target or a non-boolean activate with 400", async () => {
  for (const target of [undefined, "", "system_prompt", "skill", 42, null]) {
    const payload = target === undefined ? {} : { target };
    const response = await apply(PRESET.id, payload);
    assert.equal(response.status, 400, `target ${JSON.stringify(target)} must be rejected`);
    assert.equal(
      (await response.json()).error,
      'target must be "structured_template" or "skill_file"',
    );
  }

  const activate = await apply(PRESET.id, { target: "structured_template", activate: "yes" });
  assert.equal(activate.status, 400);
  assert.equal((await activate.json()).error, "activate must be a boolean");
});

test("POST answers 404 for an unknown preset and changes no settings", async () => {
  useSkillDir();
  const before = readFileSync(settingsPath, "utf8");

  const response = await apply("no-such-preset", { target: "structured_template" });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "Preset not found");
  assert.equal(readFileSync(settingsPath, "utf8"), before);

  const traversal = await apply("../../etc/passwd", { target: "skill_file" });
  assert.equal(traversal.status, 404);
});

test("POST structured_template returns the applied result and the in-memory settings", async () => {
  useSkillDir();
  const before = readFileSync(settingsPath, "utf8");

  const response = await apply(PRESET.id, { target: "structured_template" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);

  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["result", "settings"]);

  assert.equal(body.result.target, "structured_template");
  assert.equal(typeof body.result.changed, "boolean");
  assert.equal(body.result.template, PRESET.title);
  assert.equal(body.result.path, undefined, "a template never lands on disk");

  const template = body.settings.structured_templates.find(
    (entry) => entry.name === PRESET.title,
  );
  assert.ok(template, "the preset must be upserted into structured_templates");
  assert.equal(template.text, PRESET.body);
  // activate defaults to false, so nothing becomes the active template by accident.
  assert.notEqual(body.settings.active_template, PRESET.title);

  // Memory only: applying a template must never rewrite the stored settings.
  assert.equal(readFileSync(settingsPath, "utf8"), before);
});

test("POST structured_template is an upsert: applying twice keeps one entry", async () => {
  useSkillDir();
  await apply(PRESET.id, { target: "structured_template" });
  const response = await apply(PRESET.id, { target: "structured_template" });
  assert.equal(response.status, 200);

  const body = await response.json();
  const entries = body.settings.structured_templates.filter(
    (entry) => entry.name === PRESET.title,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, PRESET.body);
});

test("POST structured_template with activate:true also selects the template", async () => {
  useSkillDir();
  const response = await apply(PRESET.id, { target: "structured_template", activate: true });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.settings.active_template, PRESET.title);
  assert.ok(body.settings.structured_templates.some((entry) => entry.name === PRESET.title));
});

test("POST skill_file writes the SKILL.md and reports its path", async () => {
  const skillDir = useSkillDir();

  const response = await apply(PRESET.id, { target: "skill_file" });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.result.target, "skill_file");
  assert.equal(body.result.template, undefined);
  assert.equal(body.result.path, join(skillDir, PRESET.id, "SKILL.md"));
  assert.ok(existsSync(body.result.path), "the skill file must exist on disk");

  const content = readFileSync(body.result.path, "utf8");
  assert.ok(content.startsWith("---\n"), "the skill file needs YAML frontmatter");
  const frontmatter = content.slice(4, content.indexOf("\n---", 4));
  // `name` 必须是规范里的 slug（就是目录名），标题只能出现在 description 里：
  // 53 条预设里 33 条标题带空格/括号/大写，写进 name 会让 SDK 的 validateName 报警。
  assert.match(frontmatter, new RegExp(`^name: ${PRESET.id}$`, "m"));
  const description = /^description: (.*)$/m.exec(frontmatter)?.[1] ?? "";
  assert.ok(description.includes(PRESET.title), "the human title survives in the description");
  assert.match(frontmatter, /^keywords:/m);
  assert.ok(content.includes(PRESET.body), "the prompt body is the skill body");

  // The settings are untouched: the target here is the filesystem, not the config.
  assert.deepEqual(readPurgeSettings().structured_templates, []);
});

test("POST skill_file reports 500 without leaking the path when the write fails", async () => {
  // A regular file where the skill directory should be: creating <file>/<id> fails,
  // which is the realistic "unwritable skill_dir" case.
  const blocker = join(testAgentDir, "skill-dir-is-a-file");
  writeFileSync(blocker, "not a directory");
  writePurgeSettings({ skill_dir: blocker });

  const response = await apply(PRESET.id, { target: "skill_file" });
  assert.equal(response.status, 500);

  const body = await response.json();
  assert.equal(body.error, "Failed to apply preset");
  assert.equal(JSON.stringify(body).includes(blocker), false);
  assert.equal(JSON.stringify(body).includes(testAgentDir), false);
});
