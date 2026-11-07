import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * route.ts 只能导出 Next 约定名。
 *
 * Next 16 会为每个 route 生成 `.next/types/app/.../route.ts`，其中用
 * `OmitWithTag<typeof import("..."), ...>` 对模块做结构校验：多一个具名导出
 * （哪怕是 `export type`）就会 TS2344、`npm run build` 直接红。而 checks 里的
 * `tsc --noEmit` 跑在 `.next/types` 生成之前，看不见这个错误——于是「checks 绿」
 * 对 build 级错误是个假信号。这个守卫把该规则提到 checks 阶段（`npm test` 的
 * scripts/**\/*.test.mjs glob 会带上它）。
 *
 * 红的时候改业务代码，别往允许清单里加名字。
 */
export const ALLOWED_ROUTE_EXPORTS = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
  "dynamic", "dynamicParams", "revalidate", "fetchCache", "runtime",
  "preferredRegion", "maxDuration", "metadata", "generateMetadata",
  "viewport", "generateViewport", "config", "instant", "experimental_ppr",
]);

/** 去掉注释，避免注释里写的 "export ..." 被误判。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const DECL_RE = /export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
const REEXPORT_RE = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g;

/** 收集一个 route.ts 源码里所有非约定导出。返回 { names, violations }。 */
export function routeExportViolations(source) {
  const code = stripComments(source);
  const violations = [];
  const names = new Set();

  if (/\bexport\s+default\b/.test(code)) violations.push("default");
  if (/export\s+\*/.test(code)) violations.push("* (re-export)");

  for (const match of code.matchAll(DECL_RE)) names.add(match[1]);
  for (const match of code.matchAll(REEXPORT_RE)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  for (const name of names) {
    if (!ALLOWED_ROUTE_EXPORTS.has(name)) violations.push(name);
  }
  return { names: [...names], violations };
}

/** 列出 rootDir 下所有 app/**\/route.ts（跳过 node_modules / 构建产物）。 */
export async function findRouteFiles(rootDir) {
  const skip = new Set(["node_modules", ".next", ".next-desktop", ".git"]);
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name === "route.ts") {
        found.push(join(dir, entry.name));
      }
    }
  }
  const appDir = join(rootDir, "app");
  await walk(appDir);
  return found.sort();
}

test("every app/**/route.ts only exports Next conventional names", async () => {
  const files = await findRouteFiles(rootDir);
  assert.ok(files.length > 0, "至少应扫到一个 route.ts，否则守卫形同虚设");
  const offenders = [];
  for (const file of files) {
    const { violations } = routeExportViolations(await readFile(file, "utf8"));
    if (violations.length) offenders.push(`${file}: ${violations.join(", ")}`);
  }
  assert.deepEqual(offenders, [],
    "route.ts 多导出了非约定名，会让 .next/types 报 TS2344、npm run build 红。\n" +
    "把校验逻辑挪到 lib/，route 只留 GET/POST/...、dynamic、runtime 等约定导出。");
});

test("the guard catches a non-conventional named export (negative case)", async (t) => {
  const dir = await mkdtemp(join(os.tmpdir(), "pi-route-exports-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "route.ts");
  await writeFile(file, [
    'export const dynamic = "force-dynamic";',
    "export async function GET() { return new Response(); }",
    "export type ConfigUpdateParse = { ok: boolean };",
    "export function parseThing(raw: unknown) { return raw; }",
  ].join("\n"));
  const { violations } = routeExportViolations(await readFile(file, "utf8"));
  assert.deepEqual(violations.sort(), ["ConfigUpdateParse", "parseThing"]);
});

test("the guard catches export default and re-exports", () => {
  assert.deepEqual(routeExportViolations("export default function handler() {}").violations, ["default"]);
  assert.deepEqual(routeExportViolations("export * from './x';").violations, ["* (re-export)"]);
  assert.deepEqual(routeExportViolations("export { helper } from './helper';").violations, ["helper"]);
});

test("the guard ignores exports named in comments and accepts the conventional set", () => {
  const source = [
    "// export function notReal() {}",
    "/* export type AlsoNotReal = 1; */",
    'export const dynamic = "force-dynamic";',
    "export const runtime = \"nodejs\";",
    "export const revalidate = 30;",
    "export async function GET() { return new Response(); }",
    "export async function POST() { return new Response(); }",
  ].join("\n");
  assert.deepEqual(routeExportViolations(source).violations, []);
});

test("findRouteFiles picks up nested routes and skips build output", async (t) => {
  const dir = await mkdtemp(join(os.tmpdir(), "pi-route-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "app", "api", "deep", "nested"), { recursive: true });
  await mkdir(join(dir, "app", ".next"), { recursive: true });
  await writeFile(join(dir, "app", "api", "deep", "nested", "route.ts"), "export async function GET() {}\n");
  await writeFile(join(dir, "app", ".next", "route.ts"), "export function nope() {}\n");
  const files = await findRouteFiles(dir);
  assert.deepEqual(files, [join(dir, "app", "api", "deep", "nested", "route.ts")]);
});
