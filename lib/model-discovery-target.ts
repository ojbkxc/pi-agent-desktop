import { resolveModelDiscoveryTarget } from "./model-discovery-auth";
import { readModelsConfig } from "./models-config-store";

/**
 * Guards for the models-config discovery/test routes. Those routes take a
 * request-supplied provider (and Base URL) but can authenticate with the
 * credentials this machine already stored for that provider. Without a check,
 * an authenticated client could point a saved provider at an attacker host and
 * read this machine's stored API key off the outgoing request. The rules here:
 *
 * - an unsaved Base URL never gets the stored credentials, and
 * - a request may not target a literal local/private address (basic SSRF guard).
 */

/** Normalize a Base URL for equality: host case via URL, ignore a trailing slash. */
export function normalizeDiscoveryBaseUrlForCompare(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${pathname}${url.search}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function isPrivateOrLoopbackIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  return (
    a === 0 // 0.0.0.0/8
    || a === 10 // 10/8
    || a === 127 // 127/8 loopback
    || (a === 169 && b === 254) // link-local (cloud metadata)
    || (a === 192 && b === 168) // 192.168/16
    || (a === 172 && b >= 16 && b <= 31) // 172.16/16
  );
}

/** A hex IPv6 group (1–4 digits) as a number, or null. */
function hextet(value: string): number | null {
  return /^[0-9a-f]{1,4}$/.test(value) ? Number.parseInt(value, 16) : null;
}

/**
 * IPv6 literals that reach this machine: unspecified, loopback, IPv4-mapped
 * (`::ffff:0:0/96`, e.g. `[::ffff:7f00:1]`, which the URL normalizer emits for
 * `[::ffff:127.0.0.1]`), link-local (`fe80::/10`) and unique-local (`fc00::/7`).
 * Brackets were already peeled by the caller.
 */
function isPrivateOrLoopbackIpv6(host: string): boolean {
  if (host === "::" || host === "::1") return true;

  // IPv4-mapped ::ffff:0:0/96. The URL normalizer emits the compressed hex form
  // (`[::ffff:7f00:1]`); accept a dotted tail (`[::ffff:127.0.0.1]`) too.
  const mapped = /^::ffff:(.+)$/.exec(host);
  if (mapped) {
    const tail = mapped[1];
    const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(tail);
    if (dotted) {
      const octets = dotted.slice(1).map(Number);
      if (octets.every((value) => value <= 255)) return isPrivateOrLoopbackIpv4(octets);
    }
    const groups = tail.split(":");
    const high = groups.length === 2 ? hextet(groups[0]) : null;
    const low = groups.length === 2 ? hextet(groups[1]) : null;
    if (high !== null && low !== null) {
      // Two 16-bit groups → the 32 bits of the embedded IPv4.
      return isPrivateOrLoopbackIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
    }
    // Any other ::ffff:... is still a mapped address; treat it as private.
    return true;
  }

  const first = hextet(host.split(":")[0] ?? "");
  if (first !== null) {
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  }
  return false;
}

function isPrivateOrLoopbackHostname(rawHostname: string): boolean {
  const host = rawHostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.includes(":")) return isPrivateOrLoopbackIpv6(host);
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((value) => value > 255)) return false;
  return isPrivateOrLoopbackIpv4(octets);
}

/**
 * Reject a discovery/test target that could reach an internal service. Only the
 * scheme and a literal hostname are checked — there is deliberately **no DNS
 * resolution**, so a public name that resolves to a private address is not
 * caught here.
 *
 * `allowPrivate` is for a target that equals the provider's **saved** endpoint
 * (e.g. a local Ollama/LM Studio URL the user configured): that is not an SSRF
 * vector, so the private/loopback check is skipped. The scheme check stays.
 * Returns an error message or null.
 */
export function validateDiscoveryBaseUrl(
  raw: string,
  options: { allowPrivate?: boolean } = {},
): string | null {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "Base URL is invalid";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Only http and https Base URLs are allowed";
  }
  if (!options.allowPrivate && isPrivateOrLoopbackHostname(url.hostname)) {
    return "Base URL cannot point at a local or private network address";
  }
  return null;
}

/** Whether a requested Base URL is the provider's saved endpoint (ignoring a trailing slash). */
export function isSameDiscoveryBaseUrl(url: string, savedBaseUrl: string | undefined): boolean {
  return savedBaseUrl !== undefined
    && normalizeDiscoveryBaseUrlForCompare(url) === normalizeDiscoveryBaseUrlForCompare(savedBaseUrl);
}

/** Read one provider entry from models.json; an unreadable file reads as missing. */
export function readStoredProvider(providerName: string): Record<string, unknown> {
  try {
    const stored = readModelsConfig() as { providers?: Record<string, unknown> };
    const provider = stored.providers?.[providerName];
    return provider && typeof provider === "object" && !Array.isArray(provider)
      ? provider as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** The endpoint already saved for this provider (models.json value, else pi's catalog). */
export async function resolveSavedDiscoveryBaseUrl(
  providerName: string,
  storedProvider: Record<string, unknown> = readStoredProvider(providerName),
): Promise<string | undefined> {
  try {
    const target = await resolveModelDiscoveryTarget(providerName, storedProvider);
    return target.baseUrl?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Base URLs the request itself asked for (provider-level and model-level overrides). */
export function requestedDiscoveryBaseUrls(
  provider: Record<string, unknown>,
  model?: Record<string, unknown>,
): string[] {
  const urls: string[] = [];
  for (const value of [provider.baseUrl, model?.baseUrl]) {
    if (typeof value === "string" && value.trim()) urls.push(value.trim());
  }
  return urls;
}

/**
 * Whether a request must **not** use this machine's stored credentials: it
 * introduced a Base URL that differs from the saved endpoint (ignoring a
 * trailing slash). When nothing is saved for the provider, any requested Base
 * URL counts as new.
 */
export function disallowsStoredDiscoveryAuth(
  requestedUrls: readonly string[],
  savedBaseUrl: string | undefined,
): boolean {
  if (savedBaseUrl === undefined) return requestedUrls.length > 0;
  return requestedUrls.some(
    (url) => normalizeDiscoveryBaseUrlForCompare(url) !== normalizeDiscoveryBaseUrlForCompare(savedBaseUrl),
  );
}
