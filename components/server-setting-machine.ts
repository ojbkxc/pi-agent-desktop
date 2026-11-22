/**
 * The save cycle behind a settings row whose value lives on the server.
 *
 * Rows are optimistic: the control moves first, the request follows. Three
 * rules keep that honest, and they are the same for every such row:
 *
 * 1. A response only wins if no later save started after it — a stale `ok` must
 *    not overwrite a newer pick, and a stale `fail` must not roll it back.
 * 2. A failed save restores what was on screen before it, so the control never
 *    keeps a value the server refused.
 * 3. The next save starts clean: `failed` and `saved` are per-attempt notes, not
 *    sticky state.
 *
 * Written as a reducer so the rules are testable without a renderer; the React
 * side is `hooks/useServerSetting.ts`, which owns the fetch and dispatches here.
 */
export interface SaveState<T> {
  value: T | null;
  /** The last value the server confirmed (load or ok); what a failure restores. */
  baseline: T | null;
  /** What to restore if the in-flight save fails. */
  previous: T | null;
  saving: boolean;
  failed: boolean;
  saved: boolean;
  /** The newest save's token; responses carrying an older one are ignored. */
  token: number;
}

export type SaveAction<T> =
  | { type: "load"; value: T }
  | { type: "read-failed" }
  | { type: "start"; next: T; token: number }
  | { type: "ok"; token: number; value: T }
  | { type: "fail"; token: number }
  | { type: "saved-expired" };

export function initialSaveState<T>(): SaveState<T> {
  return { value: null, baseline: null, previous: null, saving: false, failed: false, saved: false, token: 0 };
}

export function reduceSave<T>(state: SaveState<T>, action: SaveAction<T>): SaveState<T> {
  switch (action.type) {
    case "load":
      return { ...state, value: action.value, baseline: action.value };
    case "read-failed":
      return { ...state, failed: true };
    case "start":
      return {
        ...state,
        token: action.token,
        // Roll back to the last *confirmed* value, never to another optimistic one:
        // otherwise a failed second save restores the first save's unconfirmed pick.
        previous: state.baseline ?? state.value,
        value: action.next,
        saving: true,
        failed: false,
        saved: false,
      };
    case "ok":
      if (action.token !== state.token) return state;
      return { ...state, value: action.value, baseline: action.value, saving: false, saved: true };
    case "fail":
      if (action.token !== state.token) return state;
      return { ...state, value: state.previous, saving: false, failed: true };
    case "saved-expired":
      return { ...state, saved: false };
    default:
      return state;
  }
}

/** `read(payload)` when it yields a value, otherwise `fallback`. */
export function readOr<T>(payload: unknown, read: (payload: unknown) => T | undefined, fallback: T): T {
  const value = read(payload);
  return value === undefined ? fallback : value;
}

/**
 * What the control should show: the loaded value, or the row's fallback when the
 * first read has not answered (or failed).
 *
 * A failed GET must not freeze the control: `value === null` means "unknown, show
 * the default", not "disable the buttons". Saving is the only reason to disable.
 */
export function shown<T>(value: T | null, fallback: T): T {
  return value === null ? fallback : value;
}

/** A JSON body's own field, or `undefined` when the body is not an object. */
export function field(payload: unknown, key: string): unknown {
  if (typeof payload !== "object" || payload === null) return undefined;
  return (payload as Record<string, unknown>)[key];
}
