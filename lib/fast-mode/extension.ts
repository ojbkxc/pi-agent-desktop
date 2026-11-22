/**
 * Fast mode: a prompt-side extension that adds one `fast_mode` section, plus
 * the `/fast` command that flips it without leaving the composer.
 *
 * Why this seam and not another:
 * - `before_agent_start` + `systemPromptOptions.sections` is the incremental
 *   seam: the SDK diffs sections against what the model already has, so an
 *   unchanged fast-mode section costs nothing and the cached prefix survives.
 *   Returning `systemPrompt` instead would replace the whole prompt and cost a
 *   cache miss per turn — and would collide with `lib/purge/extension.ts`,
 *   which owns that seam and is registered last.
 * - Because it only ever touches `sections`, a later force-system-prompt
 *   handler (purge) still decides the final text. That is the documented order
 *   in lib/rpc-manager.ts and this extension must stay before it.
 *
 * The switch is read on every run, so turning fast mode off removes the
 * section from the next request without a reload.
 */
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { buildFastModeSection, FAST_MODE_SECTION, type FastModeConfig, type FastModePreset } from "./guidance";
import { readFastModeConfig, writeFastModeConfig } from "./settings";
import { describeFastMode, fastModeCompletions, FAST_MODE_COMMAND_NAME, parseFastModeArgs } from "./command";

const FAST_MODE_EXTENSION_NAME = "pi-web-fast-mode";
/** Session entry type: which preset shaped the runs that follow it. */
const FAST_MODE_ENTRY_TYPE = "pi-web:fast-mode";

/**
 * @param readConfig Re-read per run; defaults to the stored preference.
 * @param writeConfig Persist a preset; defaults to the same store the settings row writes.
 */
export function createFastModeExtension(
  readConfig: () => FastModeConfig = () => readFastModeConfig(),
  writeConfig: (next: { preset: FastModePreset }) => FastModeConfig = (next) => writeFastModeConfig(next),
): InlineExtension {
  return {
    name: FAST_MODE_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      // Per session instance: record the preset once per change, not once per turn.
      // A transcript entry per turn would bloat every session and make the logs harder
      // to read than the thing they describe.
      let recorded: string | undefined;
      pi.on("before_agent_start", (event) => {
        let config: FastModeConfig | undefined;
        let section: string | undefined;
        try {
          config = readConfig();
          section = buildFastModeSection(config);
        } catch {
          // A broken preference must never break a turn: fail to "off".
          config = undefined;
          section = undefined;
        }
        if (section) event.systemPromptOptions.sections[FAST_MODE_SECTION] = section;
        else delete event.systemPromptOptions.sections[FAST_MODE_SECTION];

        if (config) {
          const key = `${config.preset}|${Object.entries(config.switches).map(([name, on]) => `${name}:${on ? 1 : 0}`).join(",")}`;
          if (key !== recorded) {
            recorded = key;
            try {
              // `preset` alone says everything: `off` means no section was sent. An
              // extra `active` flag would be a second encoding of the same fact, and
              // two encodings drift. (Older entries carry it; readers still accept it.)
              pi.appendEntry?.(FAST_MODE_ENTRY_TYPE, {
                preset: config.preset,
                switches: config.switches,
              });
            } catch {
              // Losing the breadcrumb is not worth failing the turn over.
            }
          }
        }
        return undefined;
      });

      // `/fast` shows the current preset; `/fast <preset>` switches it. The write goes
      // through the same store the settings row uses, so the panel reflects it on reload.
      // Guarded: an older SDK or a test harness may not carry the command API, and a
      // missing command must not take the prompt section down with it.
      pi.registerCommand?.(FAST_MODE_COMMAND_NAME, {
        description: "Show or set fast mode (off | conservative | standard)",
        getArgumentCompletions: (prefix: string) => fastModeCompletions(prefix),
        handler: async (args, ctx) => {
          const parsed = parseFastModeArgs(args);
          const notify = ctx?.ui?.notify;
          if (parsed.kind === "status") {
            notify?.(describeFastMode(readConfig()), "info");
            return;
          }
          if (parsed.kind === "error") {
            notify?.(parsed.message, "warning");
            return;
          }
          try {
            notify?.(describeFastMode(writeConfig({ preset: parsed.preset })), "info");
          } catch (error) {
            notify?.(`Fast mode was not saved: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
        },
      });
    },
  };
}

export { FAST_MODE_SECTION };
