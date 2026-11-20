import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-web-purge-presets-list-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./route.ts");
const { BUILTIN_PRESETS } = await jiti.import("@/lib/purge/preset-catalog.ts");
const { DEFAULT_PRESET_LIMIT, MAX_PRESET_LIMIT, PREVIEW_CHARS } = await jiti.import("@/lib/purge/presets.ts");

after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

const CATALOG = [...BUILTIN_PRESETS];

/** The route's payload, with the status and content type asserted once. */
async function list(query = "") {
  const response = await GET(new Request(`http://localhost/api/purge/presets${query}`));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  return response.json();
}

/** The frozen `q` semantics, reimplemented from the contract as the oracle. */
function matchingPresets(q, vendor) {
  const needle = q?.toLowerCase();
  return CATALOG.filter((preset) => {
    if (vendor !== undefined && preset.vendor.toLowerCase() !== vendor.toLowerCase()) return false;
    if (!needle) return true;
    return [preset.id, preset.vendor, preset.model, preset.title, ...preset.tags]
      .some((field) => field.toLowerCase().includes(needle));
  });
}

/** `vendor` → count, order-insensitive so the assertions do not pin an ordering. */
function vendorCounts(presets) {
  const counts = new Map();
  for (const preset of presets) {
    counts.set(preset.vendor, (counts.get(preset.vendor) ?? 0) + 1);
  }
  return counts;
}

function assertVendorCounts(vendors, expected) {
  assert.deepEqual(
    new Map(vendors.map((entry) => [entry.vendor, entry.count])),
    expected,
  );
}

test("GET returns items, vendors and total for the whole catalog", async () => {
  const body = await list();
  assert.deepEqual(Object.keys(body).sort(), ["items", "total", "vendors"]);

  assert.equal(body.total, CATALOG.length);
  assert.equal(body.items.length, Math.min(body.total, DEFAULT_PRESET_LIMIT));

  for (const item of body.items) {
    // The list never ships the prompt body: it belongs to the detail route.
    assert.deepEqual(Object.keys(item).sort(), [
      "bytes",
      "id",
      "model",
      "preview",
      "tags",
      "title",
      "vendor",
    ]);
    assert.equal(typeof item.id, "string");
    assert.equal(typeof item.vendor, "string");
    assert.equal(typeof item.model, "string");
    assert.equal(typeof item.title, "string");
    assert.ok(Array.isArray(item.tags));
    assert.ok(item.tags.every((tag) => typeof tag === "string"));
    assert.equal(typeof item.bytes, "number");
    assert.ok(item.bytes > 0);
    // Code-point safe truncation: the preview never splits a surrogate pair.
    assert.ok(Array.from(item.preview).length <= PREVIEW_CHARS);
    assert.ok(CATALOG.some((preset) => preset.id === item.id));
  }

  assert.ok(Array.isArray(body.vendors));
  assert.ok(body.vendors.every((entry) => typeof entry.vendor === "string" && entry.count > 0));
  assertVendorCounts(body.vendors, vendorCounts(CATALOG));
});

test("GET with a full limit returns every catalog id in the catalog's own order", async () => {
  const body = await list(`?limit=${MAX_PRESET_LIMIT}`);
  assert.equal(body.items.length, CATALOG.length);

  const ids = body.items.map((item) => item.id);
  assert.deepEqual([...ids].sort(), CATALOG.map((preset) => preset.id).sort());
  assert.equal(new Set(ids).size, ids.length);

  // The ordering itself is the catalog's business (its own test guards it); what
  // this route owes the panel is not to re-shuffle it, so compare position by
  // position against the catalog rather than against a hard-coded sort key.
  assert.deepEqual(ids, CATALOG.map((preset) => preset.id));
});

test("GET ?q= filters on id/vendor/model/title/tags, case-insensitively", async () => {
  // Derive the search terms from the catalog itself: the route must behave the
  // same whatever the corpus happens to contain.
  const modelTerm = CATALOG[0].model.toLowerCase().split(/[\s_-]+/).find((part) => part.length >= 3);
  assert.ok(modelTerm, "the first catalog entry needs a searchable model token");

  const lower = await list(`?q=${encodeURIComponent(modelTerm)}`);
  const expected = matchingPresets(modelTerm);
  assert.ok(expected.length > 0, "the oracle must match at least the preset it came from");
  assert.equal(lower.total, expected.length);
  assert.deepEqual(
    lower.items.map((item) => item.id),
    expected.map((preset) => preset.id).slice(0, DEFAULT_PRESET_LIMIT),
  );

  // Upper case must not change which presets match.
  const upper = await list(`?q=${encodeURIComponent(modelTerm.toUpperCase())}`);
  assert.equal(upper.total, lower.total);
  assert.deepEqual(upper.items.map((item) => item.id), lower.items.map((item) => item.id));

  // The vendor name is searchable too, so a vendor word finds its whole block.
  const spacedVendor = CATALOG.find((preset) => preset.vendor.includes(" "))?.vendor;
  assert.ok(spacedVendor, "the corpus must contain a multi-word vendor");
  const vendorTerm = spacedVendor.split(" ")[0].toLowerCase();
  const expectedVendor = matchingPresets(vendorTerm);
  const byVendor = await list(`?q=${encodeURIComponent(vendorTerm)}`);
  assert.equal(byVendor.total, expectedVendor.length);
  assert.ok(byVendor.items.every((item) => item.vendor.toLowerCase().includes(vendorTerm)));
  assertVendorCounts(byVendor.vendors, vendorCounts(expectedVendor));

  // A blank search box clears the filter instead of matching nothing.
  const blank = await list("?q=%20%20");
  assert.equal(blank.total, CATALOG.length);

  // No match is an empty list, not an error.
  const none = await list("?q=zzz-no-such-preset-zzz");
  assert.deepEqual(none.items, []);
  assert.equal(none.total, 0);
  assert.deepEqual(none.vendors, []);
});

test("GET ?vendor= matches exactly, ignores case, and leaves the vendor counters alone", async () => {
  const all = await list(`?limit=${MAX_PRESET_LIMIT}`);
  const target = all.vendors.find((entry) => entry.count > 1)?.vendor ?? all.vendors[0].vendor;

  const filtered = await list(`?limit=${MAX_PRESET_LIMIT}&vendor=${encodeURIComponent(target)}`);
  const expected = matchingPresets(undefined, target);
  assert.ok(expected.length > 0);
  assert.equal(filtered.total, expected.length);
  assert.ok(filtered.items.every(
    (item) => item.vendor.toLowerCase() === target.toLowerCase(),
  ));

  const lower = await list(`?limit=${MAX_PRESET_LIMIT}&vendor=${encodeURIComponent(target.toLowerCase())}`);
  assert.equal(lower.total, filtered.total);

  // The counters describe the search only, so a vendor filter does not shrink them
  // to the single selected vendor — the chip row keeps its other choices.
  assertVendorCounts(filtered.vendors, vendorCounts(CATALOG));

  const unknown = await list("?vendor=no-such-vendor");
  assert.deepEqual(unknown.items, []);
  assert.equal(unknown.total, 0);
});

test("GET ?limit= honours the default, the cap and the non-positive fallback", async () => {
  const total = CATALOG.length;

  const byDefault = await list();
  assert.equal(byDefault.items.length, Math.min(total, DEFAULT_PRESET_LIMIT));

  for (const raw of ["0", "-5", "abc", ""]) {
    const body = await list(`?limit=${raw}`);
    assert.equal(
      body.items.length,
      Math.min(total, DEFAULT_PRESET_LIMIT),
      `limit=${JSON.stringify(raw)} must fall back to the default`,
    );
    assert.equal(body.total, total);
  }

  const small = await list("?limit=2");
  assert.equal(small.items.length, 2);
  assert.equal(small.total, total, "total ignores the limit; only items are truncated");

  const huge = await list("?limit=100000");
  assert.equal(huge.items.length, Math.min(total, MAX_PRESET_LIMIT));
  assert.equal(huge.total, total);

  // A page smaller than the catalog is a prefix of the unfiltered order.
  const page = huge.items.slice(0, 2).map((item) => item.id);
  assert.deepEqual(small.items.map((item) => item.id), page);
});
