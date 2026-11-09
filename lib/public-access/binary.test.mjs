import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * cloudflared 二进制定位（lib/public-access/binary.ts）的档位与优先级守卫。
 *
 * 背景：打包版里「下载 Cloudflare 连接器」曾直接报 Cannot find module —— 根因之一
 * 是二进制查找缺了「设置页下载落点」这一档。现在顺序固定为
 * env → user → vendor → path，高档位存在时永远胜出。
 *
 * ⚠️ 这里**没有 desktop 档**：F3 审计确认全仓没有任何地方设置
 * `PI_DESKTOP_RESOURCE_DIR`（Rust 只注入 API token / instance id / compile cache），
 * 该档在生产永远命中不了，已作为死代码删除。若有人把它加回来，本文件最后一条
 * 静态哨兵会红。显式旁挂仍走 `PI_WEB_CLOUDFLARED`。
 *
 * 测试手法：
 * - 每个用例一个临时目录，喂进假的可执行文件（内容随意，只要求 X_OK）；
 * - `PI_AGENT_HOME` 覆盖 userHome()（userHome 读的是进程 env，见下方 withFixture），
 *   绝不碰真实家目录；
 * - PATH 用我们自己的临时目录，绝不依赖真 PATH；
 * - 绝不调用真实 cloudflared。
 */

const { resolveCloudflaredBinary, bundledCloudflaredName, cloudflaredTargetTriple, userCloudflaredDir } =
  await import("./binary.ts");

/** 当前平台对应的可执行文件名（与 bundledCloudflaredName() 的默认参数一致）。 */
const NAME = bundledCloudflaredName(cloudflaredTargetTriple(), process.platform);
const IS_WINDOWS = process.platform === "win32";
/** 可直接跑的「可执行文件」：Windows 上 X_OK 退化为存在性检查，只需一个真文件。 */
const SHELL = process.execPath;
/** PATH 档用的文件名：win32 找的是 cloudflared.exe。 */
const PATH_NAME = IS_WINDOWS ? "cloudflared.exe" : "cloudflared";

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `pi-cf-binary-${label}-`));
}

/** 写一个可执行假文件，返回它的路径。 */
function writeExecutable(path) {
  writeFileSync(path, SHELL);
  if (!IS_WINDOWS) chmodSync(path, 0o755);
  return path;
}

/**
 * 为每个用例准备四个候选位置，全部落在临时目录里：
 * - env：`PI_WEB_CLOUDFLARED` 指向的一个假文件（绝对路径，不依赖名字）
 * - user：  <PI_AGENT_HOME>/.pi/agent/bin/cloudflared/<NAME>
 * - vendor：<cwd>/vendor/cloudflared/<NAME>
 * - path：  <pathDir>/<PATH_NAME>
 */
function fixture(label) {
  const root = tempDir(label);
  const cwd = join(root, "repo");
  const agentHome = join(root, "home");
  const pathDir = join(root, "path-bin");

  for (const dir of [
    join(agentHome, ".pi", "agent", "bin", "cloudflared"),
    join(cwd, "vendor", "cloudflared"),
    pathDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const envPath = join(root, "explicit-cloudflared");
  const userPath = join(agentHome, ".pi", "agent", "bin", "cloudflared", NAME);
  const vendorPath = join(cwd, "vendor", "cloudflared", NAME);
  const pathPath = join(pathDir, PATH_NAME);

  /** 只给这些档位写文件；其余保持缺失。 */
  const install = (sources) => {
    if (sources.includes("env")) writeExecutable(envPath);
    if (sources.includes("user")) writeExecutable(userPath);
    if (sources.includes("vendor")) writeExecutable(vendorPath);
    if (sources.includes("path")) writeExecutable(pathPath);
  };

  const env = {
    // 仅作记录：userHome() 读的是进程 env，withFixture 会真的设置它。
    PI_AGENT_HOME: agentHome,
    PI_WEB_CLOUDFLARED: envPath,
    PATH: pathDir,
  };

  return {
    root,
    cwd,
    env,
    agentHome,
    paths: { env: envPath, user: userPath, vendor: vendorPath, path: pathPath },
    install,
    resolve: () => resolveCloudflaredBinary(env, cwd, process.platform),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function withFixture(label, body) {
  const fx = fixture(label);
  // ⚠️ user 档经 userHome() 读的是 **process.env.PI_AGENT_HOME**（不是本函数的 env 参数），
  // 所以这里必须真的改进程环境，用完再还原——否则会去扫真实家目录。
  const previous = process.env.PI_AGENT_HOME;
  process.env.PI_AGENT_HOME = fx.agentHome;
  try {
    return body(fx);
  } finally {
    if (previous === undefined) delete process.env.PI_AGENT_HOME;
    else process.env.PI_AGENT_HOME = previous;
    fx.dispose();
  }
}

test("userCloudflaredDir 落在 PI_AGENT_HOME 下，不碰真实家目录", () => {
  const previous = process.env.PI_AGENT_HOME;
  const home = tempDir("home-env");
  process.env.PI_AGENT_HOME = home;
  try {
    assert.equal(userCloudflaredDir(), join(home, ".pi", "agent", "bin", "cloudflared"));
  } finally {
    if (previous === undefined) delete process.env.PI_AGENT_HOME;
    else process.env.PI_AGENT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("什么都没有时返回 null（不抛错）", () => {
  withFixture("none", (fx) => {
    assert.equal(fx.resolve(), null);
  });
});

test("四个档位各自单独存在时都能被解析出来，且 source 正确", () => {
  for (const source of ["env", "user", "vendor", "path"]) {
    withFixture(source, (fx) => {
      fx.install([source]);
      assert.deepEqual(fx.resolve(), { path: fx.paths[source], source }, `${source} 档未命中`);
    });
  }
});

test("优先级：env > user > vendor > path（逐档剔除验证顺序）", () => {
  const ORDER = ["env", "user", "vendor", "path"];
  withFixture("priority", (fx) => {
    // 先全部装上，再按顺序逐个移除；每轮胜出者必须正好是当前最高档。
    fx.install(ORDER);
    for (const expected of ORDER) {
      assert.deepEqual(
        fx.resolve(),
        { path: fx.paths[expected], source: expected },
        `期望 ${expected} 档胜出`,
      );
      // 移除当前档，让下一档接管。
      rmSync(fx.paths[expected], { force: true });
    }
    assert.equal(fx.resolve(), null, "全部档位移除后应返回 null");
  });
});

test("user 档优先于 vendor 与 path（打包版下载落点不能被仓库产物顶掉）", () => {
  withFixture("user-vs-vendor", (fx) => {
    fx.install(["vendor", "path", "user"]);
    assert.deepEqual(fx.resolve(), { path: fx.paths.user, source: "user" });
  });
});

test("env 档显式指向不存在的文件时继续往下找，而不是直接失败", () => {
  withFixture("env-missing", (fx) => {
    // env 指向未落盘的文件，但 PATH 档有货。
    fx.install(["path"]);
    assert.deepEqual(fx.resolve(), { path: fx.paths.path, source: "path" });
  });
});

test("候选文件存在但不可执行时不采用（user 档回落到 vendor）", () => {
  if (IS_WINDOWS) return; // Windows 无 X_OK 语义，跳过
  withFixture("not-executable", (fx) => {
    mkdirSync(join(fx.agentHome, ".pi", "agent", "bin", "cloudflared"), { recursive: true });
    writeFileSync(fx.paths.user, "not a binary"); // 不 chmod +x
    fx.install(["vendor"]);
    assert.deepEqual(fx.resolve(), { path: fx.paths.vendor, source: "vendor" });
  });
});

test("同名目录不算命中（必须是文件）", () => {
  withFixture("directory", (fx) => {
    mkdirSync(fx.paths.user, { recursive: true });
    fx.install(["path"]);
    assert.deepEqual(fx.resolve(), { path: fx.paths.path, source: "path" });
  });
});

test("PATH 档按分隔符逐目录查找，命中第一个可执行文件", () => {
  withFixture("path-order", (fx) => {
    const secondDir = join(fx.root, "path-bin-2");
    mkdirSync(secondDir, { recursive: true });
    const hit = join(secondDir, PATH_NAME);
    writeExecutable(hit);
    // 第一个目录里没有该文件，第二个才有。
    const env = { ...fx.env, PATH: `${join(fx.root, "empty-bin")}${process.platform === "win32" ? ";" : ":"}${secondDir}` };
    assert.deepEqual(resolveCloudflaredBinary(env, fx.cwd, process.platform), { path: hit, source: "path" });
  });
});

test("不带 platform 参数时按当前平台命名（与 bundledCloudflaredName 一致）", () => {
  withFixture("default-platform", (fx) => {
    fx.install(["user"]);
    const resolved = resolveCloudflaredBinary(fx.env, fx.cwd);
    assert.deepEqual(resolved, { path: join(fx.agentHome, ".pi", "agent", "bin", "cloudflared", NAME), source: "user" });
  });
});

test("云环境变量为空串/空白时视为未设置", () => {
  withFixture("blank-env", (fx) => {
    fx.install(["user"]);
    const env = { ...fx.env, PI_WEB_CLOUDFLARED: "   " };
    assert.deepEqual(resolveCloudflaredBinary(env, fx.cwd, process.platform), { path: fx.paths.user, source: "user" });
  });
});

test("已删除的 desktop 档不会复活（生产没有任何地方设置 PI_DESKTOP_RESOURCE_DIR）", async () => {
  // V4：该档是「测试覆盖了、线上是死代码」——Rust 只注入 PI_DESKTOP_API_TOKEN /
  // PI_DESKTOP_INSTANCE_ID / PI_DESKTOP_COMPILE_CACHE_DIR，tauri.conf 也没有 env。
  // 谁把它加回来，这条会立刻红，提醒先证明真有注入方。
  const source = await readFile(new URL("./binary.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /PI_DESKTOP_RESOURCE_DIR/, "desktop 档的环境变量不该再被读取");
  assert.doesNotMatch(source, /source:\s*"desktop"/, 'CloudflaredSource 不该再有 "desktop"');
});