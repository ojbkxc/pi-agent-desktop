/**
 * Contract for the Purge Console (破甲控制台) — the request-governance panel.
 *
 * Ported from AIGX `src/purge/mod.rs`. This module is the shared type/limit/
 * default contract only; it imports nothing so both the settings API and the
 * data-plane modules can depend on it without cycles.
 *
 * The stored JSON shape lives under the `purge` key of Pi Web's own settings
 * file (`~/.pi/agent/pi-web/settings.json`), written by `lib/purge-settings.ts`.
 */

/** Reasoning effort the panel may clamp a request down to. `off` strips the ask. */
export type PurgeThinkingFloor = "off" | "low" | "medium" | "high" | "xhigh";

/** One literal `from` → `to` text rewrite. */
export interface PurgeRewriteRule {
  from: string;
  to: string;
}

/**
 * One named structured template: the text `structured_prompt` appends when it is
 * the active one. Presets land here as `{ name: title, text: body }`; the name
 * is the identity, so applying the same preset twice overwrites rather than
 * appends.
 */
export interface PurgeTemplate {
  name: string;
  text: string;
}

export interface PurgeSettings {
  /** Master switch. Off means the data plane leaves the request untouched. */
  enabled: boolean;
  /** Merge consecutive system messages, collapse blank runs, strip configured prefixes. */
  system_normalize: boolean;
  /** Literal `rewrite_rules` substitution over system/user text. */
  dead_zone_rewrite: boolean;
  /** Second rewrite pass: neutral `synonym_pairs` substitution. */
  synonym_enabled: boolean;
  /** Down-clamp explicit high/medium/xhigh reasoning to `reasoning_floor`. */
  reduce_reasoning: boolean;
  /** Append matching SKILL.md content from `skill_dir` to the last user message. */
  skill_inject: boolean;
  /** Append `structured_suffix` to the last user message. */
  structured_prompt: boolean;
  reasoning_floor: PurgeThinkingFloor;
  rewrite_rules: PurgeRewriteRule[];
  synonym_pairs: PurgeRewriteRule[];
  /** Line prefixes dropped by `system_normalize`. */
  normalize_strip_prefixes: string[];
  /**
   * Skill directory, kept verbatim (a leading `~` is expanded by the consumer,
   * never here — reading the settings must not touch the filesystem).
   */
  skill_dir: string;
  /** Per-request cap on injected skill characters. */
  skill_inject_limit: number;
  /** Text appended by `structured_prompt`; an empty string disables the append. */
  structured_suffix: string;
  /**
   * Named templates the operator can switch between. A preset applied from the
   * library lands here; the body is kept verbatim.
   */
  structured_templates: PurgeTemplate[];
  /**
   * Name of the template `structured_prompt` uses. An empty string (or a name
   * that no longer exists) falls back to `structured_suffix`.
   */
  active_template: string;
}

export interface PurgeLimits {
  skill_inject_limit: { min: number; max: number };
}

export const PURGE_LIMITS: PurgeLimits = {
  skill_inject_limit: { min: 16, max: 20_000 },
};

/** Every valid `reasoning_floor`, in the order the UI should offer them. */
export const PURGE_THINKING_FLOORS: readonly PurgeThinkingFloor[] = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
];

export const DEFAULT_PURGE_SKILL_DIR = "~/.agents/skills";

/**
 * AIGX's `DEFAULT_STRUCTURED_SUFFIX`.
 *
 * Deliberately empty: this text used to be appended to every request by default,
 * which silently rewrote what the user sent without any surface showing it. An
 * operator who wants a suffix now writes one — the console's field is theirs to
 * fill, and `structured_prompt` with an empty suffix appends nothing.
 */
export const DEFAULT_STRUCTURED_SUFFIX = "";

/** AIGX's five neutral rewrite examples; the operator may add or remove any of them. */
const DEFAULT_REWRITE_RULES: readonly PurgeRewriteRule[] = [
  { from: "渗透测试", to: "授权的安全评估测试" },
  { from: "漏洞利用", to: "漏洞验证（授权环境）" },
  { from: "黑客", to: "安全研究人员" },
  { from: "抓包", to: "流量分析" },
  { from: "破解", to: "逆向分析（自有程序）" },
];

/** Neutral synonym examples, a subset of AIGX's list. */
const DEFAULT_SYNONYM_PAIRS: readonly PurgeRewriteRule[] = [
  { from: "黑客", to: "安全研究人员" },
  { from: "漏洞利用", to: "漏洞验证" },
  { from: "攻击", to: "测试" },
  { from: "破解", to: "分析" },
  { from: "渗透", to: "评估" },
];

function copyRules(rules: readonly PurgeRewriteRule[]): PurgeRewriteRule[] {
  return rules.map((rule) => ({ from: rule.from, to: rule.to }));
}

/** A fresh defaults object each call, so a caller can never mutate shared state. */
export function defaultPurgeSettings(): PurgeSettings {
  return {
    enabled: false,
    system_normalize: false,
    dead_zone_rewrite: false,
    synonym_enabled: false,
    reduce_reasoning: false,
    skill_inject: false,
    structured_prompt: false,
    reasoning_floor: "low",
    rewrite_rules: copyRules(DEFAULT_REWRITE_RULES),
    synonym_pairs: copyRules(DEFAULT_SYNONYM_PAIRS),
    normalize_strip_prefixes: [],
    skill_dir: DEFAULT_PURGE_SKILL_DIR,
    skill_inject_limit: 2_000,
    structured_suffix: DEFAULT_STRUCTURED_SUFFIX,
    structured_templates: [],
    active_template: "",
  };
}