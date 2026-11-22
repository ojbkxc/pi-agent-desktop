/**
 * The docs index is load-bearing: AGENTS.md is what an agent reads before
 * touching an area, so a page that exists but is never linked is a page nobody
 * finds. This keeps both directions true — every `docs/agents/*.md` has an
 * entry, and every `docs/agents/…` link resolves to a file.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
const docsDir = join(root, "docs", "agents");
const pages = readdirSync(docsDir).filter((name) => name.endsWith(".md"));
const linked = new Set(
  [...agents.matchAll(/docs\/agents\/([a-z0-9.-]+\.md)/g)].map((match) => match[1]),
);

test("every page under docs/agents is linked from AGENTS.md", () => {
  const unlinked = pages.filter((page) => !linked.has(page));
  assert.deepEqual(unlinked, [], `add an index line for: ${unlinked.join(", ")}`);
});

test("every docs/agents link in AGENTS.md resolves", () => {
  const broken = [...linked].filter((page) => {
    try {
      return !statSync(join(docsDir, page)).isFile();
    } catch {
      return true;
    }
  });
  assert.deepEqual(broken, [], `AGENTS.md points at missing pages: ${broken.join(", ")}`);
});

test("an index line says what the page is for, not just its name", () => {
  // "- [x.md](docs/agents/x.md): …" — the colon and a sentence are the point of
  // the index; a bare list of links would make the reader open every file. A line
  // that merely mentions the path (a table cell, a Files: list) does not count.
  for (const page of pages) {
    const escaped = page.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const line = agents
      .split(/\r?\n/)
      .find((candidate) => new RegExp(`\\[${escaped}\\]\\(docs/agents/${escaped}\\): \\S`).test(candidate));
    assert.ok(line, `no index line with a description for ${page}`);
  }
});

test("the decisions page opens with the ideas already rejected", () => {
  // A decision log read top-down must answer "has this been tried?" before the
  // reader spends an afternoon on it. Each row carries its evidence and its D-number.
  const page = readFileSync(join(root, "docs", "agents", "fork-fast-mode-decisions.md"), "utf8");
  assert.ok(page.includes("已经否掉的，不要重做"), "the rejected list sits at the top");
  for (const id of ["D4", "D11", "D12", "D13"]) {
    assert.ok(page.includes(id), `the rejected list must cite ${id}`);
  }
  for (const command of ["--tools", "--live"]) {
    assert.ok(page.includes(command), `the re-check command ${command} must be named`);
  }
  // The section comes before the first "why" section, not buried at the end.
  assert.ok(
    page.indexOf("已经否掉的，不要重做") < page.indexOf("## 起点"),
    "the rejected list precedes the reasoning",
  );
});

test("the script map names every entry point and every script says what it is", () => {
  const page = readFileSync(join(root, "docs", "agents", "fork-fast-mode.md"), "utf8");
  assert.ok(page.includes("脚本对照表"), "the map exists");
  for (const script of [
    "check-fast-mode.mjs",
    "measure-turns.mjs",
    "mutation-smoke.mjs",
    "microbench.mjs",
  ]) {
    assert.ok(page.includes(script), `the map must name ${script}`);
  }
  // Each entry point opens with a docblock: a script nobody can identify from its
  // first screen is one people run by guessing.
  for (const file of ["check-fast-mode.mjs", "measure-turns.mjs", "mutation-smoke.mjs", "microbench.mjs", "fast-mode-live.mjs", "fast-mode-checks.mjs"]) {
    const source = readFileSync(join(root, "scripts", file), "utf8");
    const head = source.slice(0, 400);
    assert.match(head, /^#!.*\n\/\*\*|\/\*\*/, `${file} must open with a docblock`);
  }
});

test("accepted trade-offs are listed with evidence, not left implicit", () => {
  const page = readFileSync(join(root, "docs", "agents", "fork-fast-mode-decisions.md"), "utf8");
  assert.ok(page.includes("已知取舍"), "the accepted trade-offs have their own section");
  for (const topic of ["chat-only", "201 字节", "1,281", "stat", "mtime", "默认 `off`", "mutation-smoke"]) {
    assert.ok(page.includes(topic), `trade-off missing: ${topic}`);
  }
  // A trade-off without a cost is marketing; each row must say what it buys or costs.
  assert.ok(page.indexOf("已知取舍") < page.indexOf("## 起点"), "it precedes the reasoning");
});

test("every fast-mode script is reachable: a named entry or an imported helper", () => {
  // The audit that motivated this: a script nobody names and nothing imports is dead
  // weight that still looks maintained. Entries are named in the doc map; helpers must be
  // imported by an entry; tests are reached by the npm globs (see test-globs.test.mjs).
  const scripts = readdirSync(join(root, "scripts"))
    .filter((name) => /^(fast-mode|measure-turns|check-fast-mode|mutation-smoke|microbench|doc-commands)/.test(name));
  const page = readFileSync(join(root, "docs", "agents", "fork-fast-mode.md"), "utf8");
  const entries = ["check-fast-mode.mjs", "measure-turns.mjs", "mutation-smoke.mjs", "microbench.mjs"];
  for (const name of scripts) {
    if (name.endsWith(".test.mjs")) continue;
    if (entries.includes(name)) {
      assert.ok(page.includes(name), `${name} is an entry but the map does not name it`);
      continue;
    }
    const imported = entries.some((entry) =>
      readFileSync(join(root, "scripts", entry), "utf8").includes(`./${name}`),
    );
    assert.ok(imported, `${name} is neither an entry nor imported by one`);
  }
});
