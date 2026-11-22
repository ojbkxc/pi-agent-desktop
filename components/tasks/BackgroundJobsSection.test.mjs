import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const {
  BackgroundJobsList,
  BACKGROUND_JOB_STATUS_KEY,
  backgroundCommandPreview,
  backgroundStatusTone,
} = await jiti.import("./BackgroundJobsSection.tsx");

const component = await readFile(new URL("./BackgroundJobsSection.tsx", import.meta.url), "utf8");
const tasksView = await readFile(new URL("./TasksView.tsx", import.meta.url), "utf8");
const theme = await readFile(new URL("../../app/native-theme.css", import.meta.url), "utf8");

function renderWithI18n(element) {
  return renderToStaticMarkup(React.createElement(I18nProvider, { initialLocale: "en" }, element));
}

function job(overrides) {
  return {
    version: 1,
    id: "job-1",
    sessionId: "s1",
    toolCallId: "tc1",
    command: "npm run build",
    cwd: "/repo",
    label: "",
    status: "running",
    startedAt: new Date("2026-11-22T00:00:00Z").toISOString(),
    outputPath: "/tmp/job-1.log",
    outputTruncated: false,
    timeoutSec: 7200,
    ...overrides,
  };
}

test("backgroundCommandPreview collapses whitespace and truncates with an ellipsis", () => {
  assert.equal(backgroundCommandPreview("  npm   run\n build  "), "npm run build");
  const long = "x".repeat(200);
  const preview = backgroundCommandPreview(long, 10);
  assert.equal(preview.length, 10);
  assert.ok(preview.endsWith("…"));
});

test("backgroundStatusTone maps running → running, errors → failed, the rest → done", () => {
  assert.equal(backgroundStatusTone("running"), "running");
  assert.equal(backgroundStatusTone("failed"), "failed");
  assert.equal(backgroundStatusTone("timedout"), "failed");
  assert.equal(backgroundStatusTone("completed"), "done");
  assert.equal(backgroundStatusTone("stopped"), "done");
  assert.equal(backgroundStatusTone("interrupted"), "done");
});

test("every job status has an i18n key", () => {
  assert.deepEqual(Object.keys(BACKGROUND_JOB_STATUS_KEY).sort(), [
    "completed",
    "failed",
    "interrupted",
    "running",
    "stopped",
    "timedout",
  ]);
});

test("a running job renders its command, status and a Stop button", () => {
  const html = renderWithI18n(
    React.createElement(BackgroundJobsList, {
      jobs: [job({ status: "running" })],
      onStop() {},
    }),
  );
  assert.match(html, /npm run build/);
  assert.match(html, /running/);
  assert.match(html, /<button[^>]*class="tasks-action tasks-background-stop"/);
  assert.match(html, />Stop</);
  // Not the raw i18n key.
  assert.doesNotMatch(html, /tasks\.background\.(status|stop)/);
});

test("a finished job shows no Stop button and shows its exit code", () => {
  const html = renderWithI18n(
    React.createElement(BackgroundJobsList, {
      jobs: [job({ status: "completed", exitCode: 0, finishedAt: new Date("2026-11-22T00:01:00Z").toISOString() })],
      onStop() {},
    }),
  );
  assert.match(html, /completed/);
  assert.match(html, /exit 0/);
  assert.doesNotMatch(html, /class="tasks-action tasks-background-stop"/);
});

test("a failed stop surfaces an alert for that row", () => {
  const html = renderWithI18n(
    React.createElement(BackgroundJobsList, {
      jobs: [job({ status: "running" })],
      stopFailedId: "job-1",
      onStop() {},
    }),
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /Could not stop this command\./);
});

test("the section is mounted in the Tasks page", () => {
  assert.match(tasksView, /import \{ BackgroundJobsSection \} from "\.\/BackgroundJobsSection"/);
  assert.match(tasksView, /<BackgroundJobsSection \/>/);
});

test("the container polls the list while visible and POSTs a stop, with no SSE", () => {
  assert.match(component, /fetch\("\/api\/background-jobs"/);
  assert.match(component, /\/api\/background-jobs\?id=\$\{encodeURIComponent\(id\)\}/);
  assert.match(component, /method: "POST"/);
  assert.match(component, /isVisible: \(\) => document\.visibilityState === "visible"/);
  assert.match(component, /window\.addEventListener\("focus", refresh\)/);
  // No new server stream: this reuses the Tasks poller, not EventSource.
  assert.doesNotMatch(component, /EventSource/);
});

test("the background-command styling lives in the fork theme file", () => {
  assert.match(theme, /\.tasks-background-card \{/);
  assert.match(theme, /\.tasks-background-command \{/);
  assert.match(theme, /\.tasks-background-stop \{/);
});
