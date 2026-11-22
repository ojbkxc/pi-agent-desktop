/**
 * One-shot seeding for an editable field whose default resolves asynchronously
 * (the current session's cwd). The field starts at `defaultCwd ?? ""`, and a
 * later `defaultCwd` should fill an untouched, still-empty field exactly once.
 *
 * The bug this guards: `if (!cwd && defaultCwd) setCwd(defaultCwd)` runs on every
 * render, so a user who deletes the value has it snapped back to the default on
 * the next render — making a brand-new path impossible to type.
 */
export interface SeedDefaultCwdState {
  /** The default has already been applied (or the field started filled). */
  seeded: boolean;
  /** The user has typed in / cleared the field. */
  userEdited: boolean;
}

export interface SeedDefaultCwdDecision {
  seeded: boolean;
  /** Value to write into the field, or null for "leave it alone". */
  value: string | null;
}

export function nextSeededCwd(
  state: SeedDefaultCwdState,
  current: string,
  defaultCwd: string | null,
): SeedDefaultCwdDecision {
  if (state.seeded || state.userEdited) return { seeded: state.seeded, value: null };
  if (!defaultCwd) return { seeded: state.seeded, value: null };
  // The default is available for the first time. Fill only an empty field; a
  // field that already shows a value (initial state came from defaultCwd) just
  // marks itself seeded so a later clear is not undone.
  return { seeded: true, value: current ? null : defaultCwd };
}
