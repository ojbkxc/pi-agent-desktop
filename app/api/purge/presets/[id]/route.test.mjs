import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-web-purge-presets-detail-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./route.ts");
const { BUILTIN_PRESETS } = await jiti.import("@/lib/purge/preset-catalog.ts");

after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

const CATALOG = [...BUILTIN_PRESETS];
const SAMPLE = CATALOG[0];

/** Next hands dynamic segments in as a promise; call the handler the same way. */
function detail(id) {
  return GET(
    new Request(`http://localhost/api/purge/presets/${encodeURIComponent(id)}`),
    { params: Promise.resolve({ id }) },
  );
}

test("GET returns the preset with its full body", async () => {
  const response = await detail(SAMPLE.id);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);

  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["preset"]);

  const preset = body.preset;
  // `sha256` stays server-side: the detail ships the text, not its fingerprint.
  assert.deepEqual(Object.keys(preset).sort(), [
    "body",
    "bytes",
    "id",
    "model",
    "preview",
    "tags",
    "title",
    "vendor",
  ]);
  assert.equal(preset.id, SAMPLE.id);
  assert.equal(preset.vendor, SAMPLE.vendor);
  assert.equal(preset.model, SAMPLE.model);
  assert.equal(preset.title, SAMPLE.title);
  assert.deepEqual(preset.tags, [...SAMPLE.tags]);

  // The body is the source text, byte for byte — no trimming, no re-encoding.
  assert.equal(preset.body, SAMPLE.body);
  assert.ok(preset.body.length > 0);
  assert.equal(Buffer.byteLength(preset.body, "utf8"), preset.bytes);
  assert.equal(preset.bytes, SAMPLE.bytes);
  assert.equal(createHash("sha256").update(preset.body, "utf8").digest("hex"), SAMPLE.sha256);

  // The preview is a code-point-safe prefix of the body, so it never disagrees with it.
  assert.ok(preset.body.startsWith(preset.preview));
  assert.ok(Array.from(preset.preview).length <= Array.from(preset.body).length);
});

test("GET resolves every catalog id", async () => {
  for (const preset of CATALOG) {
    const response = await detail(preset.id);
    assert.equal(response.status, 200, `${preset.id} must resolve`);
    const body = await response.json();
    assert.equal(body.preset.id, preset.id);
    assert.equal(body.preset.body, preset.body);
  }
});

test("GET answers 404 for an unknown preset", async () => {
  const response = await detail("no-such-preset");
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(typeof body.error, "string");
  assert.equal(body.error, "Preset not found");
});

test("GET refuses path traversal and empty ids with 404, never a file read", async () => {
  for (const id of ["../etc/passwd", "..", "0x8d-jailbreaks-bigpickle-opencode/../../x", "", "  ", "中文预设"]) {
    const response = await detail(id);
    assert.equal(response.status, 404, `id ${JSON.stringify(id)} must not resolve`);
    const body = await response.json();
    assert.equal(body.error, "Preset not found");
  }
});

test("GET is case-sensitive on the id, matching the catalog exactly", async () => {
  const upper = SAMPLE.id.toUpperCase();
  assert.notEqual(upper, SAMPLE.id);
  const response = await detail(upper);
  assert.equal(response.status, 404);
});
