import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 宿主运行时变量不得进入任何项目侧子进程。
 *
 * 三条路径曾经各自手搓一份剥离清单：PTY 只剥 PI_WEB_PASSWORD、后台任务完全
 * 继承 env、git-changes 直接 `{ ...process.env }`。而 PI_DESKTOP_API_TOKEN 是
 * `/api/desktop/save` raw 分支（任意绝对路径写）的唯一凭据——任何一个 `env`
 * 把 token 打进终端回放 / job 输出 / git 钩子，就等于交出那把钥匙。
 * 这里钉的是「三处都用同一份清单」，而不是各自实现得像。
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const { sanitizeProjectCommandEnvironment, childProcessEnvironment } = await jiti.import("../lib/project-command-env.ts");

const HOST_SECRETS = {
  PI_WEB_PASSWORD: "pw",
  PI_DESKTOP_API_TOKEN: "tok",
  PI_DESKTOP_INSTANCE_ID: "iid",
  PORT: "30141",
  NODE_ENV: "production",
  NEXT_PUBLIC_X: "1",
  NEXT_PRIVATE_Y: "2",
};

function withEnv(overrides, run) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("sanitizeProjectCommandEnvironment drops every host runtime variable", () => {
  const cleaned = sanitizeProjectCommandEnvironment({ ...HOST_SECRETS, PATH: "/usr/bin", HOME: "/home/me" });
  for (const key of Object.keys(HOST_SECRETS)) {
    assert.equal(key in cleaned, false, `${key} must be stripped`);
  }
  assert.equal(cleaned.PATH, "/usr/bin", "ordinary variables survive");
  assert.equal(cleaned.HOME, "/home/me");
});

test("the strip list is case-insensitive on win32 only", () => {
  const win = sanitizeProjectCommandEnvironment({ pi_web_password: "pw", next_x: "1", Port: "1" }, "win32");
  assert.deepEqual(win, {}, "win32 folds case, so the lowercase spellings are stripped too");
  const linux = sanitizeProjectCommandEnvironment({ pi_web_password: "pw", next_x: "1" }, "linux");
  assert.equal(linux.pi_web_password, "pw", "POSIX env names are case-sensitive; a lowercase name is a different variable");
});

test("childProcessEnvironment strips the same set and applies overrides last", () => {
  withEnv(HOST_SECRETS, () => {
    const env = childProcessEnvironment({ LC_ALL: "C" });
    for (const key of Object.keys(HOST_SECRETS)) {
      assert.equal(key in env, false, `${key} must not reach a child process`);
    }
    assert.equal(env.LC_ALL, "C");
    // An override may name a stripped variable on purpose (git wants a fixed locale);
    // it must not be able to smuggle a secret back in.
    const forced = childProcessEnvironment({ PI_WEB_PASSWORD: "explicit" });
    assert.equal(forced.PI_WEB_PASSWORD, "explicit", "an explicit override wins over the strip list");
  });
});

test("the three child-process call sites all route through the shared list", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

  // PTY：不再手写 PI_WEB_PASSWORD 单键过滤。
  const terminal = read("../lib/terminal-manager.ts");
  assert.match(terminal, /sanitizeProjectCommandEnvironment\(process\.env\)/);
  assert.doesNotMatch(terminal, /comparableKey !== "PI_WEB_PASSWORD"/, "the hand-written single-key filter is gone");

  // 后台任务：spawn 必须带 env。
  const jobs = read("../lib/background-jobs/runtime.ts");
  assert.match(jobs, /env: childProcessEnvironment\(\)/, "background jobs spawned with the host env = token in the job log");

  // git：同样是共享清单 + 固定 locale。
  const git = read("../lib/git-changes.ts");
  assert.match(git, /env: childProcessEnvironment\(\{ LC_ALL: "C" \}\)/);
  assert.doesNotMatch(git, /env: \{ \.\.\.process\.env, LC_ALL: "C" \}/, "a bare process.env handed to git lets a cloned repo's pager read the token");
});