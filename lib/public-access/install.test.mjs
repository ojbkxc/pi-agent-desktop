import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * 设置页「下载 cloudflared」（lib/public-access/install.ts）的守卫。
 *
 * 背景：打包版 resources 里曾缺 prepare-cloudflared.mjs，本来只是「找不到脚本」，
 * 却因为直接 spawn 一个不存在的模块，把 Node 的 "Cannot find module …" 原样回传给
 * 界面。「找不到 = missing-script，且一次都不 spawn」是这两条测试要钉住的契约。
 *
 * execFile 的替身：jiti 把 TS 编译成 CJS（内部走 require），而 `node:child_process`
 * 的 CJS 导出对象是可写/可配置的普通对象，所以**在 import install.ts 之前**改写
 * `require("node:child_process").execFile` 即可被它的 `import { execFile }` 绑定看到。
 * 测试结束（after）还原。全程不 spawn、不下载；如替身未生效会立刻在断言里暴露。
 */

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const REAL_EXEC_FILE = childProcess.execFile;

/** execFile 调用记录：{ file, args, options }。 */
const execFileCalls = [];
/** 下一次 execFile 的回调剧本。 */
let nextResult = { error: null, stdout: "", stderr: "" };

function fakeExecFile(file, args, options, callback) {
  execFileCalls.push({ file, args, options });
  const { error, stdout, stderr } = nextResult;
  // 真 execFile 是异步的；queueMicrotask 保持同样时序（Promise 不会被同步 resolve）。
  queueMicrotask(() => callback(error, stdout, stderr));
  return { pid: 1 };
}

/** 清空记录与剧本。 */
function resetExecFile() {
  execFileCalls.length = 0;
  nextResult = { error: null, stdout: "", stderr: "" };
}

// 必须在 jiti 求值 install.ts 之前替换。
childProcess.execFile = fakeExecFile;
after(() => { childProcess.execFile = REAL_EXEC_FILE; });

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { installCloudflared, resolveCloudflaredInstallScript, cloudflaredInstallScriptCandidates } =
  await jiti.import("./install.ts");
// userCloudflaredDir 从 binary.ts 导出（install.ts 只是转调它）。
const { userCloudflaredDir } = await jiti.import("./binary.ts");

/** 每个用例一个临时根目录；返回仓库根（cwd）。 */
function sandbox(label) {
  const root = mkdtempSync(join(tmpdir(), `pi-cf-install-${label}-`));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  return { root, repo, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** 在临时目录里落一个真实存在的假脚本，返回其路径（env 由调用方用 withEnv 设置）。 */
function writeScript(box) {
  const script = join(box.root, "prepare-cloudflared.mjs");
  writeFileSync(script, "// fake prepare-cloudflared\n");
  return script;
}

/** 进程环境变量的存取（测试之间必须还原，避免污染真实环境）。支持 sync/async body。 */
function withEnv(vars, body) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  let result;
  try {
    result = body();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === "function") return result.finally(restore);
  restore();
  return result;
}

test("ensure-fake-execfile: 替身确实生效（防止测试自己骗自己）", () => {
  resetExecFile();
  childProcess.execFile("file", ["arg"], {}, () => {});
  assert.equal(execFileCalls.length, 1);
  assert.equal(typeof execFileCalls[0].file, "string");
  resetExecFile();
});

test("三个候选都不存在 → {ok:false, code:'missing-script'}，且 execFile 一次都没被调用", async () => {
  const box = sandbox("missing");
  resetExecFile();
  try {
    await withEnv({ PI_WEB_CLOUDFLARED_SCRIPT: undefined }, async () => {
      assert.equal(resolveCloudflaredInstallScript(box.repo), null);
      const result = await installCloudflared(box.repo);
      assert.equal(result.ok, false);
      assert.equal(result.code, "missing-script");
      // 报错文案要说明找过哪些位置，但绝不能是 Node 的 "Cannot find module"。
      assert.match(result.message, /prepare-cloudflared\.mjs not found/);
      assert.doesNotMatch(result.message, /Cannot find module/);
      assert.equal(execFileCalls.length, 0, "缺脚本时绝不能 spawn 子进程");
    });
  } finally {
    box.dispose();
  }
});

test("候选顺序：env 覆盖 > cwd/scripts > cwd/../scripts", () => {
  const box = sandbox("candidates");
  try {
    const env = { PI_WEB_CLOUDFLARED_SCRIPT: "/custom/prepare-cloudflared.mjs" };
    assert.deepEqual(cloudflaredInstallScriptCandidates(box.repo, env), [
      "/custom/prepare-cloudflared.mjs",
      join(box.repo, "scripts", "prepare-cloudflared.mjs"),
      join(box.repo, "..", "scripts", "prepare-cloudflared.mjs"),
    ]);
    // 没有 env 覆盖时只有后两项。
    assert.deepEqual(cloudflaredInstallScriptCandidates(box.repo, {}), [
      join(box.repo, "scripts", "prepare-cloudflared.mjs"),
      join(box.repo, "..", "scripts", "prepare-cloudflared.mjs"),
    ]);
  } finally {
    box.dispose();
  }
});

test("找到脚本 → execFile(execPath, [script, '--dir', userCloudflaredDir()])，退出 0 → code:'ok'", async () => {
  const box = sandbox("ok");
  resetExecFile();
  nextResult = { error: null, stdout: "cloudflared-x downloaded\n", stderr: "" };
  try {
    const script = writeScript(box);
    await withEnv({ PI_AGENT_HOME: join(box.root, "home"), PI_WEB_CLOUDFLARED_SCRIPT: script }, async () => {
      const result = await installCloudflared(box.repo);
      assert.equal(result.ok, true);
      assert.equal(result.code, "ok");
      assert.equal(result.message, "cloudflared-x downloaded");

      assert.equal(execFileCalls.length, 1, "只调用一次 execFile");
      const call = execFileCalls[0];
      assert.equal(call.file, process.execPath, "用当前 node 执行脚本，不依赖 shebang");
      assert.deepEqual(call.args, [script, "--dir", userCloudflaredDir()], "参数必须是 [script, --dir, 用户落点]");
      assert.equal(call.options.cwd, box.repo);
      assert.equal(typeof call.options.timeout, "number");
      assert.ok(call.options.timeout >= 60_000, "下载是慢操作，超时要给足");
    });
  } finally {
    box.dispose();
  }
});

test("非零退出 / spawn 失败 → code:'download-failed'，stderr 进 message（截断 500）", async () => {
  const box = sandbox("fail");
  try {
    const script = writeScript(box);
    await withEnv({ PI_WEB_CLOUDFLARED_SCRIPT: script }, async () => {
      // 情况一：子进程跑起来但以错误退出，stderr 有内容（含多余空白）。
      resetExecFile();
      nextResult = { error: new Error("exit 1"), stdout: "", stderr: "  download failed: 503 Service Unavailable  \n" };
      const failed = await installCloudflared(box.repo);
      assert.equal(failed.ok, false);
      assert.equal(failed.code, "download-failed");
      assert.equal(failed.message, "download failed: 503 Service Unavailable", "stderr 去空白并原样带出");

      // 情况二：没有 stderr 时退回 error.message。
      resetExecFile();
      nextResult = { error: new Error("spawn ENOENT"), stdout: "", stderr: "" };
      const noStderr = await installCloudflared(box.repo);
      assert.equal(noStderr.code, "download-failed");
      assert.equal(noStderr.message, "spawn ENOENT");

      // 情况三：超长 stderr 截断到 500 字符。
      resetExecFile();
      nextResult = { error: new Error("boom"), stdout: "", stderr: "x".repeat(900) };
      const truncated = await installCloudflared(box.repo);
      assert.equal(truncated.message.length, 500);
    });
  } finally {
    box.dispose();
  }
});

test("成功后 stdout 为空时给稳定的兜底文案", async () => {
  const box = sandbox("empty-ok");
  resetExecFile();
  nextResult = { error: null, stdout: "   ", stderr: "" };
  try {
    const script = writeScript(box);
    const result = await withEnv({ PI_WEB_CLOUDFLARED_SCRIPT: script }, () => installCloudflared(box.repo));
    assert.equal(result.ok, true);
    assert.equal(result.code, "ok");
    assert.equal(result.message, "cloudflared ready");
  } finally {
    box.dispose();
  }
});