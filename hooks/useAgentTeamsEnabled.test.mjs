import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

/**
 * Agent Team 的 armed 语义：勾选 = 「下一条消息用团队」，带团队指令的消息发出后复位。
 *
 * 这里测两类东西：
 * 1. 纯函数 —— localStorage 值的解析、发送后是否消耗 armed；
 * 2. store 本身 —— 默认开、复位写入、只在 armed 时复位。
 *    React hook 需要 DOM，跑不动，改用文件末尾的接线断言钉住 hook 的读取方式。
 */

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
};

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});

const {
  AGENT_TEAMS_ENABLED_DEFAULT,
  parseAgentTeamsEnabled,
  shouldDisarmAgentTeam,
  setAgentTeamsEnabled,
  disarmAgentTeam,
  useAgentTeamsEnabled,
} = await jiti.import("./useAgentTeamsEnabled.ts", { default: false });
const { withAgentTeamRequest } = await jiti.import("@/lib/agent-team-request.ts", { default: false });

test("first use defaults to armed; only an explicit true arms it", () => {
  assert.equal(AGENT_TEAMS_ENABLED_DEFAULT, true);
  assert.equal(parseAgentTeamsEnabled(null), true, "nothing stored yet → default armed");
  assert.equal(parseAgentTeamsEnabled("true"), true);
  assert.equal(parseAgentTeamsEnabled("false"), false, "the disarm write");
  // Anything else is not an arming.
  for (const raw of ["", "0", "null", "off"]) {
    assert.equal(parseAgentTeamsEnabled(raw), false, `stored ${JSON.stringify(raw)}`);
  }
});

test("only a message that really carries the team block consumes the arming", () => {
  const wrapped = withAgentTeamRequest("修一下登录");
  assert.equal(shouldDisarmAgentTeam(true, wrapped), true, "armed plain message is consumed");
  assert.equal(shouldDisarmAgentTeam(false, wrapped), false, "already disarmed: nothing to do");
  assert.equal(shouldDisarmAgentTeam(true, "今天天气不错"), false, "unwrapped text never consumes");
  // Commands stay unwrapped (they must keep their leading / or !), so they leave the arming alone.
  assert.equal(shouldDisarmAgentTeam(true, withAgentTeamRequest("/compact")), false);
  assert.equal(shouldDisarmAgentTeam(true, "/compact"), false);
  assert.equal(shouldDisarmAgentTeam(true, "!npm test"), false);
});

test("setAgentTeamsEnabled persists the flag under the shared app-pref key", async () => {
  const { APP_PREF_KEYS } = await jiti.import("@/lib/app-prefs.ts", { default: false });
  assert.equal(APP_PREF_KEYS.agentTeamsEnabled, "pi-agent-teams-enabled");

  setAgentTeamsEnabled(false);
  assert.equal(storage.get("pi-agent-teams-enabled"), "false");
  setAgentTeamsEnabled(true);
  assert.equal(storage.get("pi-agent-teams-enabled"), "true");
});

test("disarmAgentTeam turns an armed flag off and is idempotent", () => {
  setAgentTeamsEnabled(true);
  disarmAgentTeam();
  assert.equal(storage.get("pi-agent-teams-enabled"), "false", "one sent team message disarms");
  disarmAgentTeam();
  assert.equal(storage.get("pi-agent-teams-enabled"), "false", "a second disarm is a no-op");
  // It must not overwrite a deliberate arming later on.
  setAgentTeamsEnabled(true);
  assert.equal(storage.get("pi-agent-teams-enabled"), "true");
});

test("a fresh module instance restores what localStorage kept", async () => {
  storage.set("pi-agent-teams-enabled", "false");
  // Read through the same parse path a cold-loaded store uses.
  const { getPref } = await jiti.import("@/lib/app-prefs.ts", { default: false });
  assert.equal(getPref("pi-agent-teams-enabled"), "false");
  assert.equal(parseAgentTeamsEnabled(getPref("pi-agent-teams-enabled")), false, "disarmed state survives reloads");
});

test("hook wiring keeps useSyncExternalStore and the default-true server snapshot", async () => {
  const source = await readFile(new URL("./useAgentTeamsEnabled.ts", import.meta.url), "utf8");
  assert.match(source, /useSyncExternalStore\(subscribe, getSnapshot, \(\) => AGENT_TEAMS_ENABLED_DEFAULT\)/);
  assert.match(source, /export function disarmAgentTeam\(\)/);
  assert.match(source, /if \(!getSnapshot\(\)\) return;/, "an already-disarmed flag is never rewritten");
  assert.equal(typeof useAgentTeamsEnabled, "function");
});