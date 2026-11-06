import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const {
  MARKETPLACE_URL_DEFAULT,
  marketplaceUrl,
  parseMarketplace,
  installSourceFor,
  fetchMarketplace,
} = await jiti.import("./plugin-marketplace.ts");

const VALID_CATALOG = {
  name: "pi-extensions",
  owner: { name: "ojbkxc" },
  metadata: { description: "cross-end extension catalog", version: "0.1.0" },
  plugins: [
    {
      name: "lsp-mcp",
      source: { source: "github", repo: "ojbkxc/lsp-mcp", ref: "main" },
      description: "LSP extension",
      version: "1.1.0",
      license: "ISC",
      homepage: "https://github.com/ojbkxc/lsp-mcp",
      repository: "https://github.com/ojbkxc/lsp-mcp",
      keywords: ["lsp", "extension"],
    },
    {
      name: "pi-team",
      source: { source: "github", repo: "ojbkxc/pi-team" },
      description: "team extension",
      version: "0.2.0",
      keywords: ["team"],
    },
  ],
};

test("marketplaceUrl uses the constant by default", () => {
  assert.equal(marketplaceUrl({}), MARKETPLACE_URL_DEFAULT);
  assert.equal(
    MARKETPLACE_URL_DEFAULT,
    "https://raw.githubusercontent.com/ojbkxc/pi-extensions/main/.omp-plugin/marketplace.json",
  );
});

test("marketplaceUrl reads the PI_WEB_MARKETPLACE_URL override, ignoring a blank one", () => {
  assert.equal(marketplaceUrl({ PI_WEB_MARKETPLACE_URL: "https://example.test/catalog.json" }), "https://example.test/catalog.json");
  assert.equal(marketplaceUrl({ PI_WEB_MARKETPLACE_URL: "   " }), MARKETPLACE_URL_DEFAULT);
  assert.equal(marketplaceUrl({ PI_WEB_MARKETPLACE_URL: "" }), MARKETPLACE_URL_DEFAULT);
});

test("parseMarketplace projects a valid catalog into entries with install sources", () => {
  const catalog = parseMarketplace(VALID_CATALOG);

  assert.equal(catalog.name, "pi-extensions");
  assert.equal(catalog.owner, "ojbkxc");
  assert.equal(catalog.description, "cross-end extension catalog");
  assert.equal(catalog.version, "0.1.0");
  assert.equal(catalog.entries.length, 2);

  const [lsp, team] = catalog.entries;
  assert.equal(lsp.name, "lsp-mcp");
  assert.equal(lsp.source, "github:ojbkxc/lsp-mcp#main");
  assert.equal(lsp.installSource, "git:https://github.com/ojbkxc/lsp-mcp@main");
  assert.ok(!lsp.installSource.includes("#"), "installSource must not carry a #ref (SDK splitRef only splits on @)");
  assert.equal(lsp.unsupported, undefined);
  assert.equal(lsp.license, "ISC");
  assert.deepEqual(lsp.keywords, ["lsp", "extension"]);

  assert.equal(team.installSource, "git:https://github.com/ojbkxc/pi-team");
});

test("parseMarketplace defaults optional entry fields", () => {
  const catalog = parseMarketplace({
    name: "cat",
    owner: { name: "me" },
    plugins: [{ name: "a", source: { source: "npm", package: "a" } }],
  });
  const [entry] = catalog.entries;
  assert.equal(entry.description, "");
  assert.equal(entry.version, "");
  assert.deepEqual(entry.keywords, []);
  assert.equal(entry.license, undefined);
  assert.equal(catalog.description, undefined);
  assert.equal(catalog.version, undefined);
});

test("parseMarketplace rejects an invalid root object", () => {
  assert.throws(() => parseMarketplace(null), /<root>/);
  assert.throws(() => parseMarketplace([1, 2]), /<root>/);
  assert.throws(() => parseMarketplace("x"), /<root>/);
});

test("parseMarketplace rejects an invalid name", () => {
  assert.throws(() => parseMarketplace({ owner: { name: "me" }, plugins: [] }), /"name"/);
  assert.throws(() => parseMarketplace({ name: "-bad", owner: { name: "me" }, plugins: [] }), /"name"/);
  assert.throws(() => parseMarketplace({ name: "a".repeat(65), owner: { name: "me" }, plugins: [] }), /"name"/);
});

test("parseMarketplace rejects an invalid owner", () => {
  assert.throws(() => parseMarketplace({ name: "cat", plugins: [] }), /owner\.name/);
  assert.throws(() => parseMarketplace({ name: "cat", owner: {}, plugins: [] }), /owner\.name/);
  assert.throws(() => parseMarketplace({ name: "cat", owner: { name: "" }, plugins: [] }), /owner\.name/);
  assert.throws(() => parseMarketplace({ name: "cat", owner: ["x"], plugins: [] }), /owner\.name/);
});

test("parseMarketplace rejects a non-array plugins field", () => {
  assert.throws(() => parseMarketplace({ name: "cat", owner: { name: "me" } }), /"plugins"/);
  assert.throws(() => parseMarketplace({ name: "cat", owner: { name: "me" }, plugins: {} }), /"plugins"/);
});

test("parseMarketplace rejects malformed entries and every illegal source variant", () => {
  const base = (plugins) => ({ name: "cat", owner: { name: "me" }, plugins });

  // Entry not an object.
  assert.throws(() => parseMarketplace(base([null])), /plugins\[0\]/);
  // Invalid entry name.
  assert.throws(() => parseMarketplace(base([{ source: { source: "npm", package: "a" } }])), /plugins\[0\]\.name/);
  // Source neither a string nor an object.
  assert.throws(() => parseMarketplace(base([{ name: "a", source: 42 }])), /plugins\[0\]\.source/);
  // Plain string source must start with "./".
  assert.throws(() => parseMarketplace(base([{ name: "a", source: "x" }])), /must start with "\.\/"/);
  // Unknown object variant.
  assert.throws(
    () => parseMarketplace(base([{ name: "a", source: { source: "ftp", url: "ftp://x/y" } }])),
    /unknown source variant "ftp"/,
  );
  // github missing repo.
  assert.throws(
    () => parseMarketplace(base([{ name: "a", source: { source: "github" } }])),
    /plugins\[0\]\.source\.repo/,
  );
  // url missing url.
  assert.throws(
    () => parseMarketplace(base([{ name: "a", source: { source: "url" } }])),
    /plugins\[0\]\.source\.url/,
  );
  // git-subdir missing path.
  assert.throws(
    () => parseMarketplace(base([{ name: "a", source: { source: "git-subdir", url: "https://x/y" } }])),
    /plugins\[0\]\.source\.path/,
  );
  // npm missing package.
  assert.throws(
    () => parseMarketplace(base([{ name: "a", source: { source: "npm" } }])),
    /plugins\[0\]\.source\.package/,
  );
});

test("parseMarketplace rejects case-insensitive duplicate names", () => {
  assert.throws(
    () => parseMarketplace({
      name: "cat",
      owner: { name: "me" },
      plugins: [
        { name: "Foo", source: { source: "npm", package: "a" } },
        { name: "foo", source: { source: "npm", package: "b" } },
      ],
    }),
    /duplicate plugin name/,
  );
});

test("a string \"./\" source parses but is reported unsupported", () => {
  const catalog = parseMarketplace({
    name: "cat",
    owner: { name: "me" },
    plugins: [{ name: "local", source: "./plugins/local" }],
  });
  assert.equal(catalog.entries[0].source, "./plugins/local");
  assert.equal(catalog.entries[0].installSource, undefined);
  assert.match(catalog.entries[0].unsupported, /catalog repository/);
});

test("installSourceFor maps github, url and npm with optional ref/version", () => {
  assert.deepEqual(
    installSourceFor({ source: "github", repo: "ojbkxc/lsp-mcp" }),
    { installSource: "git:https://github.com/ojbkxc/lsp-mcp" },
  );
  assert.deepEqual(
    installSourceFor({ source: "github", repo: "ojbkxc/lsp-mcp", ref: "v1.2.3" }),
    { installSource: "git:https://github.com/ojbkxc/lsp-mcp@v1.2.3" },
  );
  // An explicit URL repo is used verbatim, not prefixed with github.com.
  assert.deepEqual(
    installSourceFor({ source: "github", repo: "https://gitlab.com/o/r" }),
    { installSource: "git:https://gitlab.com/o/r" },
  );

  assert.deepEqual(
    installSourceFor({ source: "url", url: "https://example.com/repo.git" }),
    { installSource: "git:https://example.com/repo.git" },
  );
  assert.deepEqual(
    installSourceFor({ source: "url", url: "https://example.com/repo.git", ref: "dev" }),
    { installSource: "git:https://example.com/repo.git@dev" },
  );

  assert.deepEqual(
    installSourceFor({ source: "npm", package: "@scope/thing" }),
    { installSource: "npm:@scope/thing" },
  );
  assert.deepEqual(
    installSourceFor({ source: "npm", package: "@scope/thing", version: "1.4.0" }),
    { installSource: "npm:@scope/thing@1.4.0" },
  );
});

test("installSourceFor refs use @, never #, so the parsed repo stays clean", () => {
  // Regression: with "#main" the SDK's splitRef (utils/git.js) leaves "#main"
  // inside repo, and installGit's `git clone <repo>` targets a broken URL (128).
  const refs = [
    installSourceFor({ source: "github", repo: "ojbkxc/lsp-mcp", ref: "main" }),
    installSourceFor({ source: "github", repo: "https://github.com/ojbkxc/lsp-mcp", ref: "feature/x" }),
    installSourceFor({ source: "url", url: "https://gitlab.com/group/repo.git", ref: "dev" }),
    installSourceFor({ source: "url", url: "https://gitlab.com/group/repo.git", ref: "release/1.0" }),
  ];
  for (const { installSource } of refs) {
    assert.ok(installSource, "has an install source");
    assert.ok(installSource.includes("@"), `ref is attached with @: ${installSource}`);
    assert.ok(!installSource.includes("#"), `no #ref in ${installSource}`);
  }
});

test("installSourceFor marks git-subdir, relative paths and unknown shapes unsupported", () => {
  const subdir = installSourceFor({ source: "git-subdir", url: "https://x/y", path: "packages/a" });
  assert.equal(subdir.installSource, undefined);
  assert.match(subdir.unsupported, /git-subdir/);

  const relative = installSourceFor("./plugins/local");
  assert.equal(relative.installSource, undefined);
  assert.match(relative.unsupported, /catalog repository/);

  const unknown = installSourceFor({ source: "ftp", url: "ftp://x" });
  assert.equal(unknown.installSource, undefined);
  assert.match(unknown.unsupported, /Unknown source variant/);

  const missing = installSourceFor({ source: "github" });
  assert.equal(missing.installSource, undefined);
  assert.match(missing.unsupported, /repo/);
});

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}

test("fetchMarketplace fetches no-store and parses a valid catalog", async () => {
  let seenUrl;
  let seenInit;
  const catalog = await fetchMarketplace({
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return jsonResponse(VALID_CATALOG);
    },
  });

  assert.equal(seenUrl, MARKETPLACE_URL_DEFAULT);
  assert.equal(seenInit.cache, "no-store");
  assert.ok(seenInit.signal, "passes an AbortSignal");
  assert.equal(catalog.entries.length, 2);
});

test("fetchMarketplace honors the env override for the URL", async () => {
  let seenUrl;
  await fetchMarketplace({
    env: { PI_WEB_MARKETPLACE_URL: "https://example.test/catalog.json" },
    fetchImpl: async (url) => {
      seenUrl = url;
      return jsonResponse(VALID_CATALOG);
    },
  });
  assert.equal(seenUrl, "https://example.test/catalog.json");
});

test("fetchMarketplace throws an upstream error on a non-2xx response", async () => {
  await assert.rejects(
    fetchMarketplace({ fetchImpl: async () => jsonResponse("nope", { ok: false, status: 503 }) }),
    (error) => {
      assert.equal(error.upstreamStatus, 503);
      assert.match(error.message, /HTTP 503/);
      return true;
    },
  );
});

test("fetchMarketplace throws on a non-JSON body", async () => {
  await assert.rejects(
    fetchMarketplace({ fetchImpl: async () => jsonResponse("<html>not json</html>") }),
    /not valid JSON/,
  );
});

test("fetchMarketplace throws on a JSON body that fails validation", async () => {
  await assert.rejects(
    fetchMarketplace({ fetchImpl: async () => jsonResponse({ name: "cat", owner: {}, plugins: [] }) }),
    /owner\.name/,
  );
});

test("fetchMarketplace propagates a timeout error", async () => {
  await assert.rejects(
    fetchMarketplace({
      fetchImpl: async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      },
    }),
    (error) => error.name === "TimeoutError",
  );
});
