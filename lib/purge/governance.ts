/**
 * Data-plane text governance — ported from AIGX `src/purge/mod.rs`
 * (`apply_messages` and its helpers), reshaped for Pi Web's two entry points:
 *
 * - the system prompt, which the SDK hands a `before_agent_start` handler, and
 * - the last user text, which the SDK hands a `context` handler.
 *
 * Both are pure functions over a string plus a settings snapshot: no session
 * state, no transcript mutation. AIGX applies, in order, normalize → literal
 * rewrite → synonym → structured suffix → skill injection; each step is behind
 * its own switch, and `enabled=false` short-circuits before any string work.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import type { PurgeRewriteRule, PurgeSettings } from "./types";

export interface GovernedText {
  text: string;
  rewrite_hits: number;
  synonym_hits: number;
  skill_hits: number;
}

export interface GovernedUserText extends GovernedText {
  /** True when `structured_suffix` was appended by this call. */
  structured: boolean;
}

/** How long a scanned skill directory is reused. Mirrors AIGX's 30 s cache. */
const SKILL_CACHE_TTL_MS = 30_000;

/** The counts a rewrite result carries. */
interface RewriteOutcome {
  text: string;
  hits: number;
}

interface SkillEntry {
  name: string;
  description: string;
  /** Frontmatter stripped; this is what gets injected. */
  body: string;
  /** `name` split on `-`, `_` and whitespace, keeping tokens of 3+ chars. */
  keywords: string[];
}

/** `dir` → the last scan. A settings change to a different dir gets its own entry. */
const skillCache = new Map<string, { scannedAt: number; entries: readonly SkillEntry[] }>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `from` → its compiled case-insensitive pattern.
 *
 * The settings are re-normalized on every event (`lib/purge-settings.ts` builds a
 * fresh object per read), so a cache keyed by the settings object would never hit
 * twice. The pattern depends only on `from`, so this map is keyed by that string
 * and survives every request. The cap only guards a pathological editor session
 * that keeps inventing new rule text; clearing it is harmless because the next
 * call simply compiles again.
 *
 * A global `RegExp` carries `lastIndex`, but `String.prototype.replace` resets it
 * before and after each call, so one instance can be reused safely.
 */
const PATTERN_CACHE_MAX = 256;
const patternCache = new Map<string, RegExp>();

function literalPattern(from: string): RegExp {
  let pattern = patternCache.get(from);
  if (pattern) return pattern;
  pattern = new RegExp(escapeRegExp(from), "gi");
  if (patternCache.size >= PATTERN_CACHE_MAX) patternCache.clear();
  patternCache.set(from, pattern);
  return pattern;
}

/**
 * Literal, case-insensitive `from` → `to` substitution over the whole text.
 *
 * Counting matches (not rules) is what makes the console's "命中" column usable:
 * a rule that hits the same phrase three times is three hits. The count and the
 * replacement are produced by one `replace` pass (the callback fires once per
 * match), where the earlier version scanned the text twice with `match` +
 * `replace`. The replacement goes through a callback so a `to` containing
 * `$&`/`$1` is still inserted literally.
 */
function applyRewriteRules(text: string, rules: readonly PurgeRewriteRule[]): RewriteOutcome {
  let out = text;
  let hits = 0;
  for (const rule of rules) {
    if (!rule || typeof rule.from !== "string" || rule.from.length === 0) continue;
    const to = typeof rule.to === "string" ? rule.to : "";
    out = out.replace(literalPattern(rule.from), () => {
      hits += 1;
      return to;
    });
  }
  return { text: out, hits };
}

/** One system line with its configured leading prefix removed; the remainder is kept verbatim. */
function stripConfiguredPrefix(line: string, prefixes: readonly string[]): string {
  const trimmedStart = line.trimStart();
  for (const prefix of prefixes) {
    if (typeof prefix !== "string" || prefix.length === 0) continue;
    if (trimmedStart.startsWith(prefix)) return trimmedStart.slice(prefix.length);
  }
  return line;
}

/**
 * `system_normalize`: drop configured line prefixes, strip line-trailing
 * whitespace (CRLF counts as trailing whitespace), and collapse runs of blank
 * lines into a single one. Line order is never touched — this is a whitespace
 * pass, not a rewriter.
 */
function normalizeSystemText(text: string, prefixes: readonly string[]): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let previousBlank = false;
  for (const raw of lines) {
    const line = stripConfiguredPrefix(raw, prefixes).replace(/[ \t\r]+$/, "");
    const blank = line.trim().length === 0;
    if (blank && previousBlank) continue;
    kept.push(line);
    previousBlank = blank;
  }
  return kept.join("\n");
}

/**
 * `~/…` and `~\\…` expand against the current user's home; anything else is used as-is.
 *
 * Exported so the preset library's `skill_file` target resolves `skill_dir` exactly
 * the way skill injection scans it — two copies of this rule drift the day one side
 * learns a new form (env override, Windows separator).
 */
export function expandHome(dir: string): string {
  const trimmed = dir.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

function unquote(value: string): string {
  return value.replace(/^["']/, "").replace(/["']$/, "").trim();
}

/**
 * Split a SKILL.md into frontmatter + body. A file without usable frontmatter
 * still counts: the directory name stands in for `name`, exactly as AIGX does.
 */
function parseSkill(content: string, fallbackName: string): SkillEntry | undefined {
  const trimmed = content.trimStart();
  let name = fallbackName;
  let description = "";
  let body = trimmed;
  if (trimmed.startsWith("---")) {
    const rest = trimmed.slice(3);
    const closing = rest.match(/\r?\n---/);
    if (closing && closing.index !== undefined) {
      for (const rawLine of rest.slice(0, closing.index).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.startsWith("name:")) name = unquote(line.slice("name:".length));
        else if (line.startsWith("description:")) description = unquote(line.slice("description:".length));
      }
      body = rest.slice(closing.index + closing[0].length).trimStart();
    }
  }
  body = body.trim();
  if (body.length === 0) return undefined;
  const keywords: string[] = [];
  for (const token of name.split(/[-_\s]+/)) {
    if (token.length >= 3 && !keywords.includes(token)) keywords.push(token);
  }
  return { name, description, body, keywords };
}

/** `settings.skill_dir` → one `SKILL.md` per child directory, sorted for a stable pick. Never throws. */
function scanSkills(dir: string): SkillEntry[] {
  const root = expandHome(dir);
  if (root.length === 0) return [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  names.sort();
  const entries: SkillEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    let content: string;
    try {
      content = readFileSync(join(root, name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const entry = parseSkill(content, name);
    if (entry) entries.push(entry);
  }
  return entries;
}

function skillsFor(dir: string): readonly SkillEntry[] {
  const cached = skillCache.get(dir);
  const now = Date.now();
  if (cached && now - cached.scannedAt < SKILL_CACHE_TTL_MS) return cached.entries;
  const entries = scanSkills(dir);
  skillCache.set(dir, { scannedAt: now, entries });
  return entries;
}

/**
 * `skill_inject`: the single best-matching skill body, appended to the user text.
 *
 * Match = any `name` token of 3+ characters occurs in the prompt, ignoring case;
 * the skill with the most such tokens wins, ties going to the first (alphabetical)
 * entry. The body is cut to `skill_inject_limit` characters. A missing or
 * unreadable directory is silence, not an error.
 */
function injectSkill(text: string, settings: PurgeSettings): { text: string; hits: number } {
  const entries = skillsFor(settings.skill_dir);
  if (entries.length === 0) return { text, hits: 0 };
  const haystack = text.toLowerCase();
  let best: SkillEntry | undefined;
  let bestHits = 0;
  for (const entry of entries) {
    let hits = 0;
    for (const keyword of entry.keywords) {
      if (haystack.includes(keyword.toLowerCase())) hits += 1;
    }
    if (hits > bestHits) {
      best = entry;
      bestHits = hits;
    }
  }
  if (!best) return { text, hits: 0 };
  const limit = Number.isFinite(settings.skill_inject_limit)
    ? Math.max(0, Math.floor(settings.skill_inject_limit))
    : 0;
  const body = best.body.slice(0, limit);
  if (body.length === 0) return { text, hits: 0 };
  return { text: `${text}\n\n${body}`, hits: 1 };
}

/** Append the structured-output ask once; an already-present suffix is left alone. */
function appendStructuredSuffix(text: string, suffix: string): { text: string; appended: boolean } {
  if (typeof suffix !== "string" || suffix.trim().length === 0) return { text, appended: false };
  if (text.includes(suffix)) return { text, appended: false };
  return { text: `${text}\n\n${suffix}`, appended: true };
}

/**
 * Govern the system prompt: normalize → literal rewrite → synonym.
 *
 * `enabled=false` returns the input string itself, before any scan, regex or
 * allocation beyond the result record — AIGX's zero-behaviour-change guarantee.
 */
export function governSystemText(text: string, settings: PurgeSettings): GovernedText {
  if (!settings || settings.enabled !== true) {
    return { text, rewrite_hits: 0, synonym_hits: 0, skill_hits: 0 };
  }
  let out = text;
  if (settings.system_normalize) {
    out = normalizeSystemText(out, settings.normalize_strip_prefixes ?? []);
  }
  let rewriteHits = 0;
  if (settings.dead_zone_rewrite && settings.rewrite_rules?.length) {
    const rewrite = applyRewriteRules(out, settings.rewrite_rules);
    out = rewrite.text;
    rewriteHits = rewrite.hits;
  }
  let synonymHits = 0;
  if (settings.synonym_enabled && settings.synonym_pairs?.length) {
    const synonym = applyRewriteRules(out, settings.synonym_pairs);
    out = synonym.text;
    synonymHits = synonym.hits;
  }
  return { text: out, rewrite_hits: rewriteHits, synonym_hits: synonymHits, skill_hits: 0 };
}

/**
 * The text `structured_prompt` appends: the active template's body when the
 * console (or a preset) activated one, otherwise the free-form suffix.
 *
 * A name that no longer matches a template falls back to the suffix rather than
 * appending nothing: the operator's suffix is the documented default, and a
 * dangling template name must not silently turn the feature off.
 */
export function resolveStructuredSuffix(settings: PurgeSettings): string {
  const name = typeof settings.active_template === "string" ? settings.active_template.trim() : "";
  if (!name) return settings.structured_suffix;
  const template = settings.structured_templates.find((item) => item.name === name);
  return template ? template.text : settings.structured_suffix;
}

/**
 * Govern the user's last text: literal rewrite → synonym → structured suffix →
 * skill injection.
 *
 * The suffix and the skill body are computed from the caller's pristine text,
 * so calling this repeatedly on the same message (every provider request of a
 * tool loop does) stays idempotent instead of stacking duplicates.
 */
export function governUserText(text: string, settings: PurgeSettings): GovernedUserText {
  if (!settings || settings.enabled !== true) {
    return { text, rewrite_hits: 0, synonym_hits: 0, skill_hits: 0, structured: false };
  }
  let out = text;
  let rewriteHits = 0;
  if (settings.dead_zone_rewrite && settings.rewrite_rules?.length) {
    const rewrite = applyRewriteRules(out, settings.rewrite_rules);
    out = rewrite.text;
    rewriteHits = rewrite.hits;
  }
  let synonymHits = 0;
  if (settings.synonym_enabled && settings.synonym_pairs?.length) {
    const synonym = applyRewriteRules(out, settings.synonym_pairs);
    out = synonym.text;
    synonymHits = synonym.hits;
  }
  const structured = settings.structured_prompt
    ? appendStructuredSuffix(out, resolveStructuredSuffix(settings))
    : { text: out, appended: false };
  out = structured.text;
  const skill = settings.skill_inject ? injectSkill(out, settings) : { text: out, hits: 0 };
  return {
    text: skill.text,
    rewrite_hits: rewriteHits,
    synonym_hits: synonymHits,
    skill_hits: skill.hits,
    structured: structured.appended,
  };
}