/**
 * Marketplace catalog client for the Plugins panel.
 *
 * The catalog is a `marketplace.json` committed to the pi-extensions repo. The
 * plugin marketplace is served from exactly two places: this fixed constant, or
 * an operator-set `PI_WEB_MARKETPLACE_URL`. A request never supplies the URL,
 * so the route cannot be turned into an SSRF probe.
 *
 * Validation mirrors the pi-extensions validator
 * (`scripts/validate-catalog.mjs`), which in turn copies oh-my-pi's real
 * `parseMarketplaceCatalog()`. That validator is a stand-in for a Bun-only
 * module we cannot import here, so the rules are re-implemented. Unlike the
 * validator, invalid input throws with a readable reason rather than reporting
 * and continuing: the API should fail loudly, never serve a half-parsed catalog.
 */

export const MARKETPLACE_URL_DEFAULT =
  "https://raw.githubusercontent.com/ojbkxc/pi-extensions/main/.omp-plugin/marketplace.json";

/** pi-extensions' NAME_RE / length cap (shared by catalog names and plugin names). */
const NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
const MAX_NAME_LENGTH = 64;

const FETCH_TIMEOUT_MS_DEFAULT = 15_000;

export interface MarketplaceEntry {
  name: string;
  description: string;
  version: string;
  license?: string;
  homepage?: string;
  repository?: string;
  keywords: string[];
  /** Canonical, human-readable label for the catalog `source`. */
  source: string;
  /** A string `DefaultPackageManager.parseSource` accepts, when installable. */
  installSource?: string;
  /** Why this entry cannot be installed, when it is not installable. */
  unsupported?: string;
}

export interface MarketplaceCatalog {
  name: string;
  owner: string;
  description?: string;
  version?: string;
  entries: MarketplaceEntry[];
}

/** The two allowed sources for the catalog URL: the constant, or an operator override. */
export function marketplaceUrl(env: Record<string, string | undefined> = process.env): string {
  const override = env.PI_WEB_MARKETPLACE_URL?.trim();
  return override || MARKETPLACE_URL_DEFAULT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidNameSegment(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME_LENGTH && NAME_RE.test(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readOwnerName(owner: unknown): string | undefined {
  if (!isRecord(owner)) return undefined;
  const name = owner.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * A readable label for a catalog `source`, independent of whether it can be
 * installed. Kept stable so the UI can show what an entry points at even when
 * `installSourceFor` refuses it.
 */
function describeSource(source: unknown): string {
  if (typeof source === "string") return source;
  if (isRecord(source)) {
    const kind = source.source;
    if (kind === "github") {
      const repo = optionalString(source.repo) ?? "";
      const ref = optionalString(source.ref);
      return `github:${repo}${ref ? `#${ref}` : ""}`;
    }
    if (kind === "url") {
      const url = optionalString(source.url) ?? "";
      const ref = optionalString(source.ref);
      return `url:${url}${ref ? `#${ref}` : ""}`;
    }
    if (kind === "git-subdir") {
      const url = optionalString(source.url) ?? "";
      const path = optionalString(source.path);
      return `git-subdir:${url}${path ? `#${path}` : ""}`;
    }
    if (kind === "npm") {
      const pkg = optionalString(source.package) ?? "";
      const version = optionalString(source.version);
      return `npm:${pkg}${version ? `@${version}` : ""}`;
    }
    if (typeof kind === "string") return kind;
  }
  return String(source);
}

/**
 * Map a catalog `source` onto a string `DefaultPackageManager.parseSource`
 * accepts (`utils/git.js` parses `git:<url>[#ref]`, npm specs are `npm:<pkg>[@ver]`).
 * Anything the installed package manager cannot fetch comes back as
 * `{ unsupported }` with a human-readable reason, never a broken source string.
 */
export function installSourceFor(source: unknown): { installSource?: string; unsupported?: string } {
  if (typeof source === "string") {
    return {
      unsupported:
        "The catalog's relative \"./\" source points inside the catalog repository and cannot be installed here.",
    };
  }
  if (!isRecord(source)) {
    return { unsupported: "The entry has no usable source." };
  }

  const kind = source.source;
  if (kind === "github") {
    const repo = optionalString(source.repo)?.trim();
    if (!repo) return { unsupported: "The github source is missing its repo." };
    const ref = optionalString(source.ref)?.trim();
    // A bare "owner/name" is a GitHub shorthand; an explicit URL is used as-is.
    const remote = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(repo) ? repo : `https://github.com/${repo}`;
    // `@`, not `#`: the SDK's splitRef (utils/git.js) only separates a ref on
    // `@`. With `#main` the ref parses but stays in `repo`, so the clone targets
    // a non-existent URL and git exits 128.
    return { installSource: `git:${remote}${ref ? `@${ref}` : ""}` };
  }

  if (kind === "url") {
    const url = optionalString(source.url)?.trim();
    if (!url) return { unsupported: "The url source is missing its url." };
    const ref = optionalString(source.ref)?.trim();
    // Same `@` rule as the github branch (see splitRef in utils/git.js).
    return { installSource: `git:${url}${ref ? `@${ref}` : ""}` };
  }

  if (kind === "npm") {
    const pkg = optionalString(source.package)?.trim();
    if (!pkg) return { unsupported: "The npm source is missing its package." };
    const version = optionalString(source.version)?.trim();
    return { installSource: `npm:${pkg}${version ? `@${version}` : ""}` };
  }

  if (kind === "git-subdir") {
    return {
      unsupported: "The git-subdir source is not supported by this installer; install the repository root instead.",
    };
  }

  return { unsupported: `Unknown source variant "${String(kind)}".` };
}

/** Validate one plugin entry and project it into a `MarketplaceEntry`, or throw. */
function parseEntry(raw: unknown, index: number, seen: Set<string>): MarketplaceEntry {
  const where = `plugins[${index}]`;
  if (!isRecord(raw)) throw new Error(`${where} must be an object`);

  if (!isValidNameSegment(raw.name)) throw new Error(`missing or invalid field "${where}.name"`);
  const name = raw.name;

  const key = name.toLowerCase();
  if (seen.has(key)) throw new Error(`duplicate plugin name "${name}" (case-equivalent)`);
  seen.add(key);

  const source = raw.source;
  if (typeof source === "string") {
    if (!source.startsWith("./")) throw new Error(`${where}.source must start with "./"`);
  } else if (isRecord(source)) {
    const variant = source.source;
    if (variant === "github") {
      if (typeof source.repo !== "string" || source.repo.length === 0) {
        throw new Error(`missing or invalid field "${where}.source.repo"`);
      }
    } else if (variant === "url" || variant === "git-subdir") {
      if (typeof source.url !== "string" || source.url.length === 0) {
        throw new Error(`missing or invalid field "${where}.source.url"`);
      }
      if (variant === "git-subdir" && (typeof source.path !== "string" || source.path.length === 0)) {
        throw new Error(`missing or invalid field "${where}.source.path"`);
      }
    } else if (variant === "npm") {
      if (typeof source.package !== "string" || source.package.length === 0) {
        throw new Error(`missing or invalid field "${where}.source.package"`);
      }
    } else {
      throw new Error(`unknown source variant "${String(variant)}" at ${where}.source.source`);
    }
  } else {
    throw new Error(`missing or invalid field "${where}.source"`);
  }

  return {
    name,
    description: optionalString(raw.description) ?? "",
    version: optionalString(raw.version) ?? "",
    license: optionalString(raw.license),
    homepage: optionalString(raw.homepage),
    repository: optionalString(raw.repository),
    keywords: readKeywords(raw.keywords),
    source: describeSource(source),
    ...installSourceFor(source),
  };
}

/**
 * Parse and validate a marketplace catalog. Throws on any invalid input with a
 * readable reason; never silently drops an entry.
 */
export function parseMarketplace(raw: unknown): MarketplaceCatalog {
  if (!isRecord(raw)) throw new Error('missing or invalid field "<root>" (must be a JSON object)');
  if (!isValidNameSegment(raw.name)) throw new Error('missing or invalid field "name"');

  const owner = readOwnerName(raw.owner);
  if (owner === undefined) throw new Error('missing or invalid field "owner.name"');

  if (!Array.isArray(raw.plugins)) throw new Error('missing or invalid field "plugins"');

  const seen = new Set<string>();
  const entries = raw.plugins.map((entry, index) => parseEntry(entry, index, seen));

  const metadata = isRecord(raw.metadata) ? raw.metadata : {};
  const description = optionalString(metadata.description) ?? optionalString(raw.description);
  const version = optionalString(metadata.version) ?? optionalString(raw.version);

  return { name: raw.name, owner, description, version, entries };
}

/** An upstream failure carrying the HTTP status the marketplace origin returned. */
function upstreamError(status: number): Error {
  return Object.assign(new Error(`Marketplace upstream returned HTTP ${status}`), { upstreamStatus: status });
}

/**
 * Fetch and parse the marketplace catalog. `fetchImpl` and `env` are injectable
 * for tests. The upstream response body is never surfaced verbatim — only the
 * status — so a misbehaving origin cannot push its payload through the API.
 */
export async function fetchMarketplace(options: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<MarketplaceCatalog> {
  const url = marketplaceUrl(options.env);
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS_DEFAULT;

  const response = await doFetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw upstreamError(response.status);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Marketplace catalog was not valid JSON");
  }
  return parseMarketplace(parsed);
}
