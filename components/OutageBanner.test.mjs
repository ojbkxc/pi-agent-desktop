import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const repoRoot = join(import.meta.dirname, "..");
const source = readFileSync(join(repoRoot, "components/OutageBanner.tsx"), "utf8").replace(/\r\n/g, "\n");
const chatWindowSource = readFileSync(join(repoRoot, "components/ChatWindow.tsx"), "utf8").replace(/\r\n/g, "\n");
const cssSource = readFileSync(join(repoRoot, "app/native-theme.css"), "utf8");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getLocalePlugin, getSupportedLocales } = await jiti.import("../lib/i18n/registry.ts");

const renderJiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { OutageBanner } = await renderJiti.import("./OutageBanner.tsx");
const { I18nProvider } = await renderJiti.import("@/hooks/useI18n");

test("renders nothing on first paint (no outage record yet)", () => {
  // The GET has not answered, so `record` is null: the header must not reserve
  // space for a banner that may never appear.
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(OutageBanner, { sessionId: "s1" }),
  ));
  assert.equal(html, "");
});

test("the banner reads /api/outage, filters by session, and offers retry/cancel", () => {
  assert.match(source, /fetch\("\/api\/outage", \{ cache: "no-store" \}\)/);
  assert.match(source, /entry\.sessionId === sessionId/);
  assert.match(source, /if \(!record\) return null/);
  assert.match(source, /JSON\.stringify\(\{ action, sessionId \}\)/);
  assert.match(source, /act\("retry"\)/);
  assert.match(source, /act\("cancel"\)/);
  // Suspended, never failed: a status line, not an alert.
  assert.match(source, /className="outage-banner" role="status"/);
  assert.doesNotMatch(source, /role="alert"/);
});

test("ChatWindow mounts the banner in the session-header strip row", () => {
  assert.match(chatWindowSource, /import \{ OutageBanner \} from "\.\/OutageBanner"/);
  assert.match(chatWindowSource, /\{teamStrip\}\s*\n\s*<OutageBanner sessionId=\{session\?\.id \?\? null\} \/>/);
});

test("the banner styling lives in the fork theme file with the warning edge", () => {
  assert.match(cssSource, /\.outage-banner \{[^}]*var\(--warning\)/);
  assert.match(cssSource, /\.outage-banner-text \{/);
  assert.match(cssSource, /\.outage-banner-actions \{/);
  assert.equal(/outage-banner[^}]*!important/.test(cssSource), false);
});

test("every banner key exists in all three language packs", () => {
  const locales = getSupportedLocales();
  assert.deepEqual(locales, ["en", "zh-CN", "zh-TW"]);
  for (const locale of locales) {
    const messages = getLocalePlugin(locale).messages;
    for (const key of ["outage.banner", "outage.bannerQuota", "tasks.retryNow", "tasks.cancelWait"]) {
      assert.equal(typeof messages[key], "string", `${locale} is missing ${key}`);
      assert.ok(messages[key].trim().length > 0, `${locale}.${key} is empty`);
    }
    // The retry counter is a placeholder, not baked-in copy.
    assert.match(messages["outage.banner"], /\{attempt\}/);
    assert.match(messages["outage.banner"], /\{max\}/);
  }
});