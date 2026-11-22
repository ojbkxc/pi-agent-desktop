"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  initialSaveState,
  readOr,
  reduceSave,
  type SaveState,
} from "@/components/server-setting-machine";

export interface ServerSetting<T> extends Pick<SaveState<T>, "value" | "saving" | "failed" | "saved"> {
  /** Optimistically set `next`, PUT it, roll back on failure. */
  update: (next: T) => void;
}

export interface ServerSettingOptions<T> {
  endpoint: string;
  /** Body sent to PUT. */
  body: (next: T) => unknown;
  /** Read the value out of a GET/PUT payload; `undefined` means unreadable. */
  read: (payload: unknown) => T | undefined;
  /** What an unreadable payload means. */
  fallback: T;
  /** How long the "saved" note stays up, in ms. */
  savedForMs?: number;
}

/**
 * One settings row's server round trip: read on mount, optimistic write, roll
 * back on failure, and a monotonic gate so a superseded response never wins.
 *
 * Shared by the boolean rows (`ServerSwitchSettingRow`) and the three-way fast
 * mode row, which is why it takes a `body`/`read` pair instead of a boolean.
 * The state transitions live in `components/server-setting-machine.ts`; this
 * hook only owns the fetch and the timers.
 */
export function useServerSetting<T>({
  endpoint,
  body,
  read,
  fallback,
  savedForMs = 2000,
}: ServerSettingOptions<T>): ServerSetting<T> {
  const [state, dispatch] = useReducer(reduceSave<T>, undefined, initialSaveState<T>);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenRef = useRef(0);
  // Callbacks are read at save time through refs, so `update` never needs the
  // current value in its dependency list (and never rebuilds on every change).
  const readRef = useRef(read);
  readRef.current = read;
  const bodyRef = useRef(body);
  bodyRef.current = body;

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  const clearSavedLater = useCallback(() => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => dispatch({ type: "saved-expired" }), savedForMs);
  }, [savedForMs]);

  useEffect(() => {
    let cancelled = false;
    fetch(endpoint)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((payload: unknown) => {
        if (!cancelled) dispatch({ type: "load", value: readOr(payload, readRef.current, fallback) });
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: "read-failed" });
      });
    return () => {
      cancelled = true;
    };
    // `fallback` is the deployment default for this row; it does not change at runtime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  const update = useCallback((next: T) => {
    // The token is minted here and carried by the response that answers this save,
    // so a superseded response can be recognised without reading render state.
    tokenRef.current += 1;
    const token = tokenRef.current;
    dispatch({ type: "start", next, token });
    if (savedTimer.current) { clearTimeout(savedTimer.current); savedTimer.current = null; }
    fetch(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyRef.current(next)),
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((payload: unknown) => {
        dispatch({ type: "ok", token, value: readOr(payload, readRef.current, next) });
        clearSavedLater();
      })
      .catch(() => dispatch({ type: "fail", token }));
  }, [endpoint, clearSavedLater]);

  return { value: state.value, saving: state.saving, failed: state.failed, saved: state.saved, update };
}
