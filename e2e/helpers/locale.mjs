// Shared UI-language pin for the e2e specs.
//
// `readInitialLocale` in hooks/useI18n.tsx only reads the stored `pi-locale`
// preference; it deliberately never reads the browser language. A browser
// context's `locale` option therefore cannot pin the interface language — the
// only lever is seeding localStorage before the app boots.
//
// Playwright exposes `addInitScript(pageFunction, arg)` on both Page and
// BrowserContext with the same signature, so a single helper covers both the
// `page` and the `context` call sites. Every spec must pin through here (not
// hand-roll the localStorage write); scripts/e2e-locale-pins.test.mjs enforces
// that so the next `defaultLocale` change cannot silently break the suite.

/** localStorage key the i18n provider reads (lib/app-prefs APP_PREF_KEYS.locale). */
export const LOCALE_PREF_KEY = "pi-locale";

/** UI languages `readInitialLocale` accepts; anything else falls back to the default. */
export const SUPPORTED_LOCALES = ["en", "zh-CN", "zh-TW"];

/**
 * Seed the stored UI language for every navigation in `target`.
 *
 * @param {import("playwright").Page | import("playwright").BrowserContext} target
 * @param {string} [locale] UI language to pin; defaults to English, the language most specs assert in
 */
export async function pinLocale(target, locale = "en") {
  await target.addInitScript(
    ({ key, value }) => localStorage.setItem(key, value),
    { key: LOCALE_PREF_KEY, value: locale },
  );
}
