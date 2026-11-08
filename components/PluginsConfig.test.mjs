import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./PluginsConfig.tsx", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  filteredPackagesKeptOn,
  packagesToSwitch,
  isMarketplaceEntryInstalled,
  marketplaceEntryKey,
  marketplaceInstallState,
} = await jiti.import("./PluginsConfig.tsx");

const packages = [
  { source: "npm:global-on", scope: "global", disabled: false, filtered: false },
  { source: "npm:global-off", scope: "global", disabled: true, filtered: true },
  { source: "npm:project-on", scope: "project", disabled: false, filtered: false },
];

test("a group switch targets the packages that would change", () => {
  assert.deepEqual(packagesToSwitch(packages, true).map((pkg) => pkg.source), ["npm:global-off"]);
  assert.deepEqual(packagesToSwitch(packages, false).map((pkg) => pkg.source), ["npm:global-on", "npm:project-on"]);
  assert.deepEqual(packagesToSwitch(packages.filter((pkg) => !pkg.disabled), true), []);
});

test("switching a group off leaves an enabled filtered package on and says so", () => {
  // Disabling empties its resource lists, and nothing would bring the filters back.
  const withFiltered = [...packages, { source: "npm:filtered-on", scope: "global", disabled: false, filtered: true }];
  assert.deepEqual(packagesToSwitch(withFiltered, false).map((pkg) => pkg.source), ["npm:global-on", "npm:project-on"]);
  assert.deepEqual(filteredPackagesKeptOn(withFiltered).map((pkg) => pkg.source), ["npm:filtered-on"]);
  assert.match(source, /const note = keptOn > 0 \? t\("plugins\.bulkKeptFiltered", \{ count: keptOn \}\) : undefined;/);
  // Even when only filtered packages are on and nothing is sent, the note shows.
  assert.match(source, /setGroupStatus\(note \? \{ scope, note \} : null\);\s+if \(targets\.length === 0\) return;/);
});

test("a group switch sends one request for its scope's packages", () => {
  assert.match(source, /packages: targets\.map\(\(\{ source \}\) => \(\{ source, scope \}\)\)/);
  assert.match(source, /setBusyKey\(`bulk:\$\{scope\}`\)/);
  // The open package's controls wait for the bulk run like for their own
  // action — and for a check-all/update-all sweep too (d5-30: bulkRunning).
  assert.match(source, /const busy = \(\(busyKey\?\.endsWith\(key\) \|\| busyKey\?\.startsWith\("bulk:"\)\) \?\? false\) \|\| bulkRunning;/);
  assert.match(source, /disabled=\{footerBusy\}\s+loading=\{busyKey === `bulk:\$\{group\.scope\}`\}/);
});

test("a bulk run confirms like the package switch and asks for a reload in an open session", () => {
  assert.match(source, /setActionMessage\(sessionId \? `\$\{message\} \$\{t\("agents\.reloadRequired"\)\}` : message\)/);
  assert.match(source, /t\("plugins\.bulkFailed", \{ count: failures\.length, total: results\.length \}\)/);
});

// --- Marketplace -----------------------------------------------------------------

const marketEntry = {
  name: "pi-team",
  installSource: "git:https://github.com/ojbkxc/pi-team#main",
};
const unsupportedEntry = {
  name: "pi-x",
  installSource: null,
  unsupported: "No install source in this catalog",
};

test("a catalog entry's resolved source decides how it installs, and a refusal is kept verbatim", () => {
  assert.deepEqual(marketplaceInstallState(marketEntry), {
    kind: "installable",
    source: "git:https://github.com/ojbkxc/pi-team#main",
  });
  assert.deepEqual(marketplaceInstallState(unsupportedEntry), {
    kind: "unsupported",
    reason: "No install source in this catalog",
  });
  // Neither field: not installable, and with no reason of its own to show.
  assert.deepEqual(marketplaceInstallState({ name: "pi-y" }), { kind: "unsupported", reason: null });
});

test("an entry counts as installed only within the scope being installed to", () => {
  const packages = [
    { source: "git:https://github.com/ojbkxc/pi-team#main", scope: "global" },
    { source: "git:https://github.com/ojbkxc/pi-team#main", scope: "project" },
  ];
  assert.equal(isMarketplaceEntryInstalled(marketEntry, packages, "global"), true);
  assert.equal(isMarketplaceEntryInstalled(marketEntry, packages, "project"), true);
  // A global install must not block a legitimate project install of the same
  // source: the badge and the disabled button follow the chosen scope only.
  const globalOnly = [{ source: "git:https://github.com/ojbkxc/pi-team#main", scope: "global" }];
  assert.equal(isMarketplaceEntryInstalled(marketEntry, globalOnly, "global"), true);
  assert.equal(isMarketplaceEntryInstalled(marketEntry, globalOnly, "project"), false);
  // Compared as strings: a near miss (dropped ref) does not count, and a
  // refusal is never installed.
  assert.equal(
    isMarketplaceEntryInstalled(marketEntry, [{ source: "git:https://github.com/ojbkxc/pi-team", scope: "global" }], "global"),
    false,
  );
  assert.equal(isMarketplaceEntryInstalled(unsupportedEntry, packages, "global"), false);
  assert.equal(marketplaceEntryKey(marketEntry), "marketplace\0pi-team");
});

test("the marketplace group loads the catalog once, refreshes on request, and reports failures", () => {
  assert.match(source, /fetch\("\/api\/plugins\/marketplace"\)/);
  assert.match(source, /useEffect\(\(\) => \{\s+void loadMarketplace\(\);\s+\}, \[loadMarketplace\]\)/);
  assert.match(source, /t\("plugins\.marketplace"\)/);
  assert.match(source, /className="config-sidebar-message is-error">\s+\{t\("plugins\.marketplaceLoadFailed", \{ error: marketplaceError \}\)\}/);
  assert.match(source, /className="config-sidebar-message is-empty">\s+\{t\("plugins\.marketplaceEmpty"\)\}/);
});

test("the add pane no longer points at the upstream catalog", () => {
  // The sidebar's marketplace group replaces it; a link to pi.dev/packages
  // would be a dead end for this fork, so the add pane offers no catalog link.
  assert.doesNotMatch(source, /pi\.dev\/packages/);
  assert.match(source, /catalogs=\{\[\]\}/);
});

test("installing a catalog entry reuses the install route with the resolved source and the chosen scope", () => {
  assert.match(source, /const installMarketEntry = useCallback\(async \(entry: MarketplaceEntry\) => \{/);
  assert.match(source, /const state = marketplaceInstallState\(entry\);\s+if \(state\.kind !== "installable"\) return;/);
  assert.match(source, /body: JSON\.stringify\(\{ action: "install", source, scope: installScope, cwd \}\)/);
  assert.match(source, /setBusyKey\(`market-install:\$\{key\}`\)/);
});

test("the detail names the real source, never shows Install for a refusal, and shows a matching scope switch", () => {
  assert.match(source, /<ConfigTrustNotice message=\{t\("plugins\.marketplaceTrust", \{ source: trustSource \}\)\} \/>/);
  assert.match(source, /const trustSource = entry\.repository\?\.trim\(\)\s+\|\| \(installable \? installState\.source : entry\.name\);/);
  // Install only when the catalog resolved a source.
  assert.match(source, /\{installable && \(\s+<ConfigButton\s+variant="primary"\s+onClick=\{onInstall\}\s+disabled=\{busy \|\| installed\}/);
  assert.match(source, /\{installState\.reason \?\? t\("plugins\.marketplaceUnsupported"\)\}/);
  // The same ConfigSaveTarget the add pane uses.
  assert.match(source, /disabledReason=\{t\("trust\.projectScopeUnavailable"\)\}/);
});

test("every marketplace string exists in all three locales", async () => {
  const { forkLocalePlugins } = await jiti.import("../lib/i18n/locale-plugins.ts");
  const keys = [
    "plugins.marketplace",
    "plugins.marketplaceEmpty",
    "plugins.marketplaceLoadFailed",
    "plugins.marketplaceInstalled",
    "plugins.marketplaceRefresh",
    "plugins.marketplaceRefreshHint",
    "plugins.marketplaceUnsupported",
    "plugins.marketplaceInstallSource",
    "plugins.marketplaceLicense",
    "plugins.marketplaceHomepage",
    "plugins.marketplaceRepository",
    "plugins.marketplaceTrust",
  ];
  assert.deepEqual(forkLocalePlugins.map((plugin) => plugin.id).sort(), ["en", "zh-CN", "zh-TW"]);
  for (const plugin of forkLocalePlugins) {
    for (const key of keys) {
      assert.ok(plugin.messages[key], `${plugin.id} is missing ${key}`);
    }
  }
});

test("row actions stand down while a bulk sweep runs (d5-30)", () => {
  // PackageDetail 的 busy/reloadBusy 必须并入 bulkRunning（updatingAll ||
  // checkingAll），否则「全部更新」期间点单包 Update/Remove 会与批量 POST
  // 并发互写 setData。
  assert.match(
    source,
    /const busy = \(\(busyKey\?\.endsWith\(key\) \|\| busyKey\?\.startsWith\("bulk:"\)\) \?\? false\) \|\| bulkRunning;/,
  );
  assert.match(source, /const reloadBusy = busyKey === "reload" \|\| bulkRunning;/);
  // 调用方必须传 bulkRunning，且取的是两个批量 in-flight 标志的并。
  assert.match(source, /bulkRunning=\{updatingAll \|\| checkingAll\}/);
});
