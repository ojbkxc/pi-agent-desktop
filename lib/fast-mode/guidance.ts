/**
 * The `fast_mode` prompt section.
 *
 * Every line here is prompt-side only: it never changes the model, the
 * reasoning level, the tool set or the request body. That is deliberate — the
 * measured cost of a slow turn on this app is dominated by output length and
 * round trips, not by the model, so the honest lever is what the model is told
 * to write and how many passes it takes.
 *
 * Rules that keep it honest:
 * - Facts only. Nothing here may claim a capability the app lacks.
 * - Deterministic. The same preset renders the same bytes, in the same order,
 *   so the SDK's section diff stays a no-op between identical runs and the
 *   cached prompt prefix survives.
 * - Small. This is sent with every request; a verbose guide costs exactly what
 *   it is trying to save.
 */

import { FAST_MODE_PRESET_IDS } from "./presets";

export const FAST_MODE_SECTION = "fast_mode";

export type FastModePreset = (typeof FAST_MODE_PRESET_IDS)[number];

export interface FastModeSwitches {
  /** Shorter final answers: no pre-announcing, no restating, no progress logs. */
  brevity: boolean;
  /** Read once when unsure instead of guessing and retrying. */
  verifyFirst: boolean;
  /** One line of plan at most before acting; act from evidence. */
  actFirst: boolean;
  /** Same call twice, or three identical results in a row: change route or stop. */
  changeApproach: boolean;
}

export interface FastModeConfig {
  preset: FastModePreset;
  switches: FastModeSwitches;
}

/** The shipped presets. `standard` is the one the panel points at. */
export const FAST_MODE_PRESETS: Record<FastModePreset, FastModeSwitches> = {
  off: { brevity: false, verifyFirst: false, actFirst: false, changeApproach: false },
  conservative: { brevity: true, verifyFirst: false, actFirst: false, changeApproach: false },
  standard: { brevity: true, verifyFirst: true, actFirst: true, changeApproach: true },
};

export const DEFAULT_FAST_MODE_PRESET: FastModePreset = "off";

/**
 * Character budget for the full `standard` section.
 *
 * The section rides on every request, so it bills like a system prompt: at
 * ~1,100 characters it is roughly 280 tokens of prefill, which is cheap against
 * a 12k-token answer and expensive if a future edit doubles it. The budget is
 * a test, not a runtime check — a section that grows past it should fail review,
 * not silently cost every turn.
 */
/**
 * Character budget for the full `standard` section.
 *
 * The section rides on every request, so it bills like a system prompt. The
 * budget is a test, not a runtime check — a section that grows past it should
 * fail review, not silently cost every turn. It sits ~70 characters above the
 * current text (1,281) so a normal wording fix fits while a new rule does not.
 */
export const FAST_MODE_SECTION_BUDGET = 1350;

export function isFastModePreset(value: unknown): value is FastModePreset {
  return value === "off" || value === "conservative" || value === "standard";
}

/** Preset first, then any per-switch override; an unknown preset is `off`. */
export function resolveFastModeConfig(
  preset: unknown,
  overrides?: Record<string, unknown>,
): FastModeConfig {
  const resolved = isFastModePreset(preset) ? preset : DEFAULT_FAST_MODE_PRESET;
  const base = { ...FAST_MODE_PRESETS[resolved] };
  if (overrides) {
    for (const key of Object.keys(base) as (keyof FastModeSwitches)[]) {
      if (typeof overrides[key] === "boolean") base[key] = overrides[key] as boolean;
    }
  }
  return { preset: resolved, switches: base };
}

// The behavior guide (`lib/agent-guide-extension.ts`) already owns the general
// concision rule — "lead with the answer, no preamble, no closing summary" — and
// it ships with every request by default. Repeating it here would bill the same
// instruction twice, so this bullet only carries what the guide does not:
// narration of *tool work* (announcements, result restating, progress logs) and
// the completeness guard that keeps brevity from eating substance.
const BREVITY = [
  "- No progress narration: do not announce a call, restate its result, or log steps. At most one line of plan before acting.",
  "- Keep the final answer complete: code, commands, file paths and any caveat the user needs stay. Content you were asked to produce — a whole file, a full artifact — is never shortened; brevity trims commentary, not deliverables.",
].join("\n");

const VERIFY_FIRST = [
  "- When a fact is uncertain and cheap to check, check it once (read the file, run the command, search) instead of guessing and redoing the work.",
  "- Do not re-read what you already have in context, and do not re-run a command whose result you already saw.",
].join("\n");

const ACT_FIRST = [
  "- Work from evidence you already collected. If you have enough to act, act; ask only when the answer changes what you would build.",
  "- Independent lookups belong in one step: issue the reads, greps or commands that do not depend on each other together, instead of one round trip each.",
  "- Prefer one correct pass over three exploratory passes.",
].join("\n");

const CHANGE_APPROACH = [
  "- If the same call would be repeated, or three consecutive results are identical, change approach: different input, different tool, or say plainly what is blocked and what you need.",
].join("\n");

/**
 * The section body for a configuration, or `undefined` when nothing is on — the
 * caller then deletes the section, which is what keeps `off` a byte-for-byte
 * passthrough of the stock prompt.
 *
 * `hasTools: false` is for a session with no tools (a locked chat): every rule
 * about calls, lookups and passes is then an instruction the model cannot follow,
 * so it is dropped instead of billing tokens for it. What survives is the one
 * rule that still applies — the answer must stay complete.
 */
export function buildFastModeSection(config: FastModeConfig): string | undefined {
  const blocks: string[] = [];
  if (config.switches.brevity) blocks.push(BREVITY);
  if (config.switches.verifyFirst) blocks.push(VERIFY_FIRST);
  if (config.switches.actFirst) blocks.push(ACT_FIRST);
  if (config.switches.changeApproach) blocks.push(CHANGE_APPROACH);
  if (blocks.length === 0) return undefined;
  return [
    "Speed rules for this session. They change how you write, not what you may do: the model, the reasoning level, the tools and the request are untouched.",
    ...blocks,
  ].join("\n\n");
}
