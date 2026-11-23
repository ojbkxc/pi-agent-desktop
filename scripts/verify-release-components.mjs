import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compareVersions,
  createComponentManifest,
  isReleasePinValid,
  readLocalComponentVersions,
  readRemoteComponentVersions,
  rootDir,
} from "./release-components.mjs";

const local = await readLocalComponentVersions();
const remote = await readRemoteComponentVersions();
const pins = JSON.parse(await readFile(join(rootDir, "scripts", "release-component-pins.json"), "utf8"));
const problems = [];

// 覆盖式重发（同一版本号、替换安装包）的显式开关。约定见
// project_repo_ci.md：fork 的发版口径是「版本号解耦于发布历史」，同一批代码用
// workflow_dispatch 重发同号。默认（未设开关）仍然是普通发版的严格规则：
// 同号 = tag 已存在 = tauri-action 会 `already_exists`，提前失败是对的。
const overwriteRelease = process.env.PI_OVERWRITE_RELEASE === "1";
if (overwriteRelease) {
  console.log("PI_OVERWRITE_RELEASE=1: the same-version overwrite re-release is on; skipping the strictly-newer check.");
}
if (
  compareVersions(local.pi, remote.pi.version) !== 0
  && !isReleasePinValid(pins.pi, local.pi)
) {
  problems.push(`pi is ${local.pi}; latest Release is ${remote.pi.version}`);
}
if (
  compareVersions(local["pi-web"], remote["pi-web"].version) !== 0
  && !isReleasePinValid(pins["pi-web"], local["pi-web"])
) {
  problems.push(`pi-web is ${local["pi-web"]}; latest Release is ${remote["pi-web"].version}`);
}
if (
  !overwriteRelease
  && remote["pi-agent-desktop"]
  && compareVersions(local["pi-agent-desktop"], remote["pi-agent-desktop"].version) <= 0
) {
  // Equal is as wrong as older in a normal release: the tag already exists, so the
  // release job would fail with `already_exists` after the whole matrix had built.
  // (An overwrite re-release deliberately replaces the tag, and opts in above.)
  problems.push(
    `pi-agent-desktop is ${local["pi-agent-desktop"]}; it must be newer than the latest Release ${remote["pi-agent-desktop"].version} (or set PI_OVERWRITE_RELEASE=1 for a same-version overwrite re-release)`,
  );
}

const expectedManifest = createComponentManifest(local);
const actualManifest = JSON.parse(await readFile(
  join(rootDir, "src-tauri", "resources", "component-versions.json"),
  "utf8",
));
if (JSON.stringify(actualManifest) !== JSON.stringify(expectedManifest)) {
  problems.push("component-versions.json does not match the bundled package versions");
}

if (problems.length > 0) {
  throw new Error(`Release verification failed:\n- ${problems.join("\n- ")}`);
}
console.log(
  `Verified pi-agent-desktop ${local["pi-agent-desktop"]}, pi ${local.pi}${isReleasePinValid(pins.pi, local.pi) ? " (pinned)" : ""}, pi-web ${local["pi-web"]}${isReleasePinValid(pins["pi-web"], local["pi-web"]) ? " (pinned)" : ""}.`,
);
