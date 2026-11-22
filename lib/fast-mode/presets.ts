/**
 * The preset ids, in the order the settings row and the docs list them.
 *
 * Kept in a client-safe module of its own: `components/FastModeSettingRow.tsx`
 * is a `"use client"` component, and importing the guidance module there would
 * pull the prompt text (and its server-side reads) into the browser bundle.
 * `guidance.ts` derives its record from this list, so the two cannot drift.
 */
export const FAST_MODE_PRESET_IDS = ["off", "conservative", "standard"] as const;
