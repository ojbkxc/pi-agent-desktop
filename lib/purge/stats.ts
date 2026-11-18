/**
 * Purge Console counters — ported from AIGX `src/purge/mod.rs` (`PurgeStats` +
 * the `record_*` bump functions), collapsed into one process-wide record.
 *
 * Process-wide on purpose: the console shows what this server did since it
 * started (`started_at`), and a restart resets everything to zero. Nothing here
 * is persisted — the settings file holds configuration, this holds activity.
 *
 * The data plane (`lib/purge/extension.ts`) is the only writer, through
 * `recordPurgeTurn()`; the management plane (`app/api/purge/route.ts`) is the
 * only reader, through `purgeStatsSnapshot()`.
 */

export interface PurgeStats {
  /** Governance invocations (system prompt + last user text, one each). */
  requests: number;
  /** Literal `rewrite_rules` occurrences replaced. */
  rewrite_hits: number;
  /** `synonym_pairs` occurrences replaced. */
  synonym_hits: number;
  /** Turns where one SKILL.md body was injected. */
  skill_hits: number;
  /** Times a reasoning level was clamped down to `reasoning_floor`. */
  reasoning_clamps: number;
  /** Times `structured_suffix` was appended to the last user text. */
  structured_appends: number;
  /** `Date.now()` of the process that owns these counters. */
  started_at: number;
}

/** Every counter a caller may bump, in a fixed order for stable snapshots. */
const TRACKED_KEYS = [
  "rewrite_hits",
  "synonym_hits",
  "skill_hits",
  "reasoning_clamps",
  "structured_appends",
] as const;

type TrackedKey = (typeof TRACKED_KEYS)[number];

const startedAt = Date.now();

const counters: Record<TrackedKey, number> = {
  rewrite_hits: 0,
  synonym_hits: 0,
  skill_hits: 0,
  reasoning_clamps: 0,
  structured_appends: 0,
};

let requests = 0;

/**
 * Count one governance invocation and add its hits.
 *
 * A delta may carry any subset of the hit counters; unknown keys are ignored and
 * non-finite or negative values are dropped, so a caller can never poison the
 * snapshot with `NaN`. `requests` always moves by one, which is what the panel's
 * "请求数" column means.
 */
export function recordPurgeTurn(
  delta: Partial<Omit<PurgeStats, "requests" | "started_at">>,
): void {
  requests += 1;
  if (!delta) return;
  for (const key of TRACKED_KEYS) {
    const value = delta[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    counters[key] += value;
  }
}

/** The current counters plus the process start time. A copy: callers cannot mutate it. */
export function purgeStatsSnapshot(): PurgeStats {
  return {
    requests,
    rewrite_hits: counters.rewrite_hits,
    synonym_hits: counters.synonym_hits,
    skill_hits: counters.skill_hits,
    reasoning_clamps: counters.reasoning_clamps,
    structured_appends: counters.structured_appends,
    started_at: startedAt,
  };
}