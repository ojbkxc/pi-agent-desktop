import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

/**
 * A1：Agent Team 开关状态层的拆分。覆盖五件事：
 * 1. 默认值 —— 全局可用性默认开、单条 armed 默认关；
 * 2. 两态互不干扰 —— 改一个不动另一个；
 * 3. 发送后复位 + 命令类豁免；
 * 4. 会话切换重算；
 * 5. 一次性发现引导的两态语义。
 *
 * React hook 需要 DOM，跑不动；hook 的读取方式用文件末尾的接线断言钉住，其余都测纯函数
 * 与内存 store（沿用既有测试的约定）。
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
  useAgentTeamsEnabled,
  setAgentTeamsArmed,
  isAgentTeamsArmed,
  armAgentTeam,
  disarmAgentTeam,
  useAgentTeamsArmed,
  resetAllAgentTeamsArmed,
  agentTeamScopeKey,
  UNSCOPED_AGENT_TEAM_KEY,
} = await jiti.import("./useAgentTeamsEnabled.ts", { default: false });
const { APP_PREF_KEYS, getPref } = await jiti.import("@/lib/app-prefs.ts", { default: false });
const { withAgentTeamRequest } = await jiti.import("@/lib/agent-team-request.ts", { default: false });
const guide = await jiti.import("@/lib/agent-teams-guide.ts", { default: false });

// 每个用例前把两套状态都归零，用例之间不互相污染。
function resetAll() {
  storage.clear();
  setAgentTeamsEnabled(false);
  resetAllAgentTeamsArmed();
  guide.resetAgentTeamGuide();
}

// ───────────────────────── 1. 默认值 ─────────────────────────

test("全局可用性默认开；单条 armed 默认关", () => {
  storage.clear();
  assert.equal(AGENT_TEAMS_ENABLED_DEFAULT, true, "首次使用全局默认可用");
  assert.equal(parseAgentTeamsEnabled(null), true, "没存过 → 全局默认开");
  assert.equal(parseAgentTeamsEnabled("true"), true);
  assert.equal(parseAgentTeamsEnabled("false"), false);
  for (const raw of ["", "0", "null", "off"]) {
    assert.equal(parseAgentTeamsEnabled(raw), false, `stored ${JSON.stringify(raw)}`);
  }
  // armed 默认关：没勾过就是关（任何会话都一样）。
  assert.equal(isAgentTeamsArmed("s1"), false, "armed 默认关");
  assert.equal(isAgentTeamsArmed(), false, "无会话键时也读作关");
  assert.equal(UNSCOPED_AGENT_TEAM_KEY, "unscoped", "无键时的归属键与真实会话 id 不会撞");
});

// ───────────────────────── 2. 两态互不干扰 ─────────────────────────

test("旧键 pi-agent-teams-enabled 的遗留值不再被读取（迁移到 -v2）", () => {
  // 注意：这里**不能**走 resetAll()——它会 setAgentTeamsEnabled(false)，往**新键**写 "false"。
  // 迁移用例要的是一个干净 storage 里只有旧键的遗留值。
  storage.clear();
  // 旧语义（「下一条消息用团队」）在每次发送后把旧键写回 "false"；升级后这些遗留值绝不能
  // 把全局功能静默关掉，否则 composer 开关会置灰、点击跳设置。
  storage.set("pi-agent-teams-enabled", "false");
  assert.equal(getPref(APP_PREF_KEYS.agentTeamsEnabled), null, "新键没写过 → 读成 null");
  assert.equal(parseAgentTeamsEnabled(getPref(APP_PREF_KEYS.agentTeamsEnabled)), true, "遗留的旧 false 必须回到默认开");
  assert.notEqual(APP_PREF_KEYS.agentTeamsEnabled, "pi-agent-teams-enabled", "新键必须与旧键不同名，否则遗留 false 会被误读");
});

test("全局可用性与单条 armed 互不干扰，且只有全局落盘", () => {
  resetAll();
  // 关掉全局，不该动 armed。
  setAgentTeamsEnabled(false);
  assert.equal(isAgentTeamsArmed("s1"), false);
  armAgentTeam("s1");
  assert.equal(isAgentTeamsArmed("s1"), true, "armed 与全局无关地打开");
  assert.equal(getPref(APP_PREF_KEYS.agentTeamsEnabled), "false", "全局偏好仍是关");

  // armed 不落盘：storage 里没有任何和 armed 有关的键。
  const armedKeys = [...storage.keys()].filter((k) => k.includes("armed"));
  assert.deepEqual(armedKeys, [], `armed 不该写 localStorage，实际写了 ${JSON.stringify(armedKeys)}`);
  // 结构上也只有 guide 两态 + 全局可用性这几个 agent-teams 键。
  assert.equal(APP_PREF_KEYS.agentTeamsEnabled, "pi-agent-teams-enabled-v2");
  assert.equal(APP_PREF_KEYS.agentTeamsGuideSeen, "pi-agent-teams-guide-seen");
  assert.equal(APP_PREF_KEYS.agentTeamsGuideDismissed, "pi-agent-teams-guide-dismissed");

  // 反过来：开关全局不影响 armed。
  armAgentTeam("s1");
  setAgentTeamsEnabled(true);
  assert.equal(isAgentTeamsArmed("s1"), true, "改全局不动 armed");
  assert.equal(getPref(APP_PREF_KEYS.agentTeamsEnabled), "true");
  assert.equal(typeof useAgentTeamsEnabled, "function");
});

// ───────────────────────── 3. 发送后复位 + 命令类豁免 ─────────────────────────

test("只有真的带上团队块的消息才消耗 armed；命令类消息豁免", () => {
  resetAll();
  const wrapped = withAgentTeamRequest("修一下登录");
  assert.equal(shouldDisarmAgentTeam(true, wrapped), true, "armed 的普通消息被消耗");
  assert.equal(shouldDisarmAgentTeam(false, wrapped), false, "已复位：无事可做");
  assert.equal(shouldDisarmAgentTeam(true, "今天天气不错"), false, "没包装的文本从不消耗");
  // 命令类消息（/、!）保持首字符，不被包装，也就不消耗这次 armed。
  assert.equal(shouldDisarmAgentTeam(true, withAgentTeamRequest("/compact")), false);
  assert.equal(shouldDisarmAgentTeam(true, "/compact"), false);
  assert.equal(shouldDisarmAgentTeam(true, "!npm test"), false);

  // 端到端：arm → 发普通消息 → 复位。
  armAgentTeam("s1");
  assert.equal(isAgentTeamsArmed("s1"), true);
  disarmAgentTeam("s1");
  assert.equal(isAgentTeamsArmed("s1"), false, "一条带团队块的消息发出去后复位");
  disarmAgentTeam("s1");
  assert.equal(isAgentTeamsArmed("s1"), false, "重复复位是 no-op");
});

test("arm/disarm 的读写与幂等", () => {
  resetAll();
  setAgentTeamsArmed(true, "s1");
  assert.equal(isAgentTeamsArmed("s1"), true);
  setAgentTeamsArmed(true, "s1");
  assert.equal(isAgentTeamsArmed("s1"), true, "重复 arm 保持真");
  disarmAgentTeam("s1");
  assert.equal(isAgentTeamsArmed("s1"), false);
});

// ───────────────────────── 4. 每会话各自记忆（2026-11-12 用户口径） ─────────────────────────

test("armed 按会话分别记忆：切走再切回，仍是离开时的样子", () => {
  resetAll();
  // A 勾上，B 不动。
  armAgentTeam("session-A");
  assert.equal(isAgentTeamsArmed("session-A"), true);
  // 切到 B：B 是关的（不串台）。
  assert.equal(isAgentTeamsArmed("session-B"), false, "切到没勾过的会话必须是关，不能把 A 的 armed 串过去");
  // 在 B 上也勾上。
  armAgentTeam("session-B");
  assert.equal(isAgentTeamsArmed("session-B"), true);
  // 切回 A：仍是离开时的打开状态。
  assert.equal(isAgentTeamsArmed("session-A"), true, "切回原会话要恢复该会话自己的 armed");
  // 在 A 上发一条带团队块的消息：只复位 A。
  disarmAgentTeam("session-A");
  assert.equal(isAgentTeamsArmed("session-A"), false);
  assert.equal(isAgentTeamsArmed("session-B"), true, "复位只作用于当前会话，不影响别的会话");
});

test("无会话键（极窄路径）落在 unscoped 上，不污染任何真实会话", () => {
  resetAll();
  armAgentTeam();
  assert.equal(isAgentTeamsArmed(), true);
  assert.equal(isAgentTeamsArmed("session-A"), false, "unscoped 的 armed 不能被真实会话读到");
  disarmAgentTeam();
  assert.equal(isAgentTeamsArmed(), false);
});

test("agentTeamScopeKey：真实会话用 id，新建会话用 new:<cwd>（跨「点新建」保持）", () => {
  assert.equal(agentTeamScopeKey("sess-1", "/repo"), "sess-1", "有会话 id 时用 id");
  assert.equal(agentTeamScopeKey(null, "/repo"), "new:/repo", "没会话 id 时用 cwd 派生的稳定键");
  assert.equal(agentTeamScopeKey("  sess-2  ", null), "sess-2", "trim 掉空白");
  assert.equal(agentTeamScopeKey(null, null), null, "既没 id 也没 cwd → 无键");
  assert.equal(agentTeamScopeKey(undefined, "  "), null);

  // 关键行为：连续点两次「新建」会换草稿键（draftId 不同），但 agentTeamScopeKey 不变，
  // 所以勾上的团队不会丢 —— 这正是用户报的那条。
  resetAll();
  const firstNew = agentTeamScopeKey(null, "/repo");
  const secondNew = agentTeamScopeKey(null, "/repo");
  assert.equal(firstNew, secondNew);
  armAgentTeam(firstNew);
  assert.equal(isAgentTeamsArmed(secondNew), true, "再点新建后仍是勾着的");
  assert.notEqual(`new:${crypto.randomUUID()}:/repo`, `new:${crypto.randomUUID()}:/repo`, "草稿键每次都不一样（对照）");
});

// ───────────────────────── 5. 一次性发现引导（两态） ─────────────────────────

test("发现引导：既没看过也没拒绝过才展示；看过 / 拒绝两态可分开", () => {
  resetAll();
  assert.equal(guide.shouldShowAgentTeamGuide(), true, "首次进入需要展示引导");
  assert.equal(guide.hasSeenAgentTeamGuide(), false);
  assert.equal(guide.isAgentTeamGuideDismissed(), false);

  // 只是看过：不再展示，但没有被拒绝。
  guide.markAgentTeamGuideSeen();
  assert.equal(guide.shouldShowAgentTeamGuide(), false);
  assert.equal(guide.hasSeenAgentTeamGuide(), true);
  assert.equal(guide.isAgentTeamGuideDismissed(), false, "看过 ≠ 拒绝");

  // 被拒绝：看过 + 明确拒绝两态都立起来。
  guide.resetAgentTeamGuide();
  guide.dismissAgentTeamGuide();
  assert.equal(guide.shouldShowAgentTeamGuide(), false);
  assert.equal(guide.hasSeenAgentTeamGuide(), true);
  assert.equal(guide.isAgentTeamGuideDismissed(), true, "拒绝态与看过态分开记录");

  // 重置后重新可展示。
  guide.resetAgentTeamGuide();
  assert.equal(guide.shouldShowAgentTeamGuide(), true);
});

// ───────────────────────── 接线断言（hook 无法在无 DOM 下运行） ─────────────────────────

test("hook 接线：两个独立 store、armed 按会话键取值、切会话不清", async () => {
  const source = await readFile(new URL("./useAgentTeamsEnabled.ts", import.meta.url), "utf8");
  // 全局可用性：默认开 + 服务端快照用默认常量。
  assert.match(source, /useSyncExternalStore\(subscribeEnabled, enabledSnapshot, \(\) => AGENT_TEAMS_ENABLED_DEFAULT\)/);
  // 单条 armed：订阅版本号（任何会话改动都重渲染），再按当前 key 从 Map 取值。
  assert.match(source, /useSyncExternalStore\(subscribeArmed, armedVersionSnapshot, \(\) => 0\)/);
  assert.match(source, /return armedBySession\.get\(key\) === true;/);
  // 切会话**不再**清 armed：源码里不该再有「keyChanged → setAgentTeamsArmed(false)」那条路径。
  assert.doesNotMatch(source, /shouldResetArmedOnSessionChange/);
  assert.doesNotMatch(source, /if \(keyChanged\) setAgentTeamsArmed\(false, key\)/);
  // 归属键由 agentTeamScopeKey 决定（真实会话 id / new:<cwd>）。
  assert.match(source, /export function agentTeamScopeKey\(/);
  assert.equal(typeof useAgentTeamsEnabled, "function");
  assert.equal(typeof useAgentTeamsArmed, "function");
  assert.equal(typeof disarmAgentTeam, "function");
  assert.equal(typeof shouldDisarmAgentTeam, "function");
  assert.equal(typeof parseAgentTeamsEnabled, "function");
  assert.equal(typeof agentTeamScopeKey, "function");
});
