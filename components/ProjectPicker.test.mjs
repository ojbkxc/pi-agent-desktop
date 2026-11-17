import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { selectVisibleProjects, shouldShowProjectFilter } = await jiti.import("./ProjectPicker.tsx");

const many = Array.from({ length: 12 }, (_, i) => `/work/project-${i}`);

test("caps the unfiltered list but offers a filter once projects exceed the cap", () => {
  assert.equal(shouldShowProjectFilter(many.slice(0, 7)), false);
  assert.equal(shouldShowProjectFilter(many), true);
  assert.equal(selectVisibleProjects(many, null, "").length, 7);
});

test("filtering searches the whole list, not just the capped rows", () => {
  // project-9 sits past the cap, so this is the regression that made every
  // project beyond the 7th unreachable when the filter box was dropped.
  assert.deepEqual(selectVisibleProjects(many, null, "project-9"), ["/work/project-9"]);
  assert.ok(!selectVisibleProjects(many, null, "").includes("/work/project-9"));
});

test("filtering is case-insensitive, trimmed, and returns every match", () => {
  assert.deepEqual(selectVisibleProjects(["/work/Alpha", "/work/beta"], null, "  ALP "), ["/work/Alpha"]);
  // project-1, project-10 and project-11 all match, and all three are returned
  // even though only project-1 is inside the cap.
  assert.deepEqual(
    selectVisibleProjects(many, null, "project-1"),
    ["/work/project-1", "/work/project-10", "/work/project-11"],
  );
  assert.deepEqual(selectVisibleProjects(many, null, "nothing"), []);
});

test("the selected project stays visible even when it falls outside the cap", () => {
  const visible = selectVisibleProjects(many, "/work/project-11", "");
  assert.equal(visible.length, 7);
  assert.ok(visible.includes("/work/project-11"));
});

test("a selected project already inside the cap is not duplicated", () => {
  const visible = selectVisibleProjects(many, "/work/project-2", "");
  assert.equal(visible.filter((p) => p === "/work/project-2").length, 1);
  assert.equal(visible.length, 7);
});

// a11y P2：文件夹 / 下拉箭头 / 加号是纯装饰图标，读屏器不应把它们当图形节点。
// 方向键菜单语义（role=menu/menuitem + useMenuNavigation）成本较高，本轮未做。
test("decorative icons leave the accessibility tree", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = (await readFile(new URL("./ProjectPicker.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  for (const icon of [
    /<svg width="14" height="14" viewBox="0 0 24 24"[^>]*aria-hidden="true"/,
    /<svg width="9" height="9" viewBox="0 0 10 10"[^>]*aria-hidden="true"/,
    /<svg width="12" height="12" viewBox="0 0 10 10"[^>]*aria-hidden="true"/,
  ]) assert.match(source, icon);
});
