import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * v0.8.2 上下文压缩策略的接线哨兵。
 *
 * 上游合并（upstream merge）可以在不改一行策略代码的情况下，静默丢掉「扩展注册到哪些
 * 会话」这件事：分支体还在、工厂函数还在，唯独装配点被合并吃掉，tsc/eslint/上游测试
 * 全绿。这里钉住五处装配：
 *
 *   - 普通项目会话：装配扩展 + 会话级 SettingsManager 阈值包装
 *   - chat workspace：装配扩展
 *   - 成员新建（lib/subagent-runtime.ts）：装配扩展 + 阈值包装
 *   - 成员恢复（lib/rpc-manager.ts 的 subagentResources 支）：装配扩展 + 阈值包装
 *   - lean / chatOnly：两者都不装配（lean「不加载扩展」、chatOnly 只保留 exact prompt）
 *
 * 失败时的默认动作是恢复装配行为，不是删断言。
 */

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const rpcManager = await read("./rpc-manager.ts");
const subagentRuntime = await read("./subagent-runtime.ts");
const subagents = await read("./subagents.ts");
const leanMode = await read("./lean-mode.ts");

const startupSource = rpcManager.slice(rpcManager.indexOf("export async function startRpcSession"));

/** 恢复路径（subagentResources 支）的 resourceLoaderOptions 片段。 */
const restoreBranch = startupSource.slice(
  startupSource.indexOf("noExtensions: !subagentResources.loadExtensions"),
  startupSource.indexOf("systemPrompt: chatWorkspacePrompt("),
);

/** chatOnly 支的 resourceLoaderOptions 片段（到普通会话分支的注释为止）。 */
const chatOnlyBranch = startupSource.slice(
  startupSource.indexOf("CHAT_ONLY_RESOURCE_LOADER_OPTIONS,"),
  startupSource.indexOf("// 普通会话：把 cc-haha 的用户级技能根一并加载"),
);

/** chat workspace 支的 extensionFactories 片段。 */
const chatBranch = startupSource.slice(
  startupSource.indexOf("systemPrompt: chatWorkspacePrompt("),
  startupSource.indexOf("CHAT_ONLY_RESOURCE_LOADER_OPTIONS,"),
);

/** 普通项目会话支的 extensionFactories 片段。 */
const normalBranch = startupSource.slice(
  startupSource.indexOf("// 普通会话：把 cc-haha 的用户级技能根一并加载"),
  startupSource.indexOf("extensionsOverride: (base) => preferUserBashExtension"),
);

test("the policy modules are imported from one place in both assembly files", () => {
  for (const source of [rpcManager, subagentRuntime]) {
    assert.match(source, /import \{ createCompactionSettingsManager \} from "\.\/compaction-policy";/);
    assert.match(source, /import \{ createCompactionModelExtension \} from "\.\/compaction-extension";/);
  }
});

test("a normal session wires both the threshold wrapper and the compaction extension", () => {
  // The wrapper must be the object handed to createAgentSessionServices: the SDK reads
  // getCompactionSettings() from services.settingsManager for all four compaction paths.
  assert.match(startupSource, /const baseSettingsManager = SettingsManager\.create\(sessionCwd, agentDir\);/);
  assert.match(
    startupSource,
    /const settingsManager = compactionEnabled\s*\?\s*createCompactionSettingsManager\(baseSettingsManager\)\s*:\s*baseSettingsManager;/,
  );
  assert.match(startupSource, /settingsManager,\s*resourceLoaderOptions: lean/);

  assert.match(normalBranch, /createCompactionModelExtension\(\),/);
  // It rides in the same list as the guide extensions, so a merge that keeps one keeps both.
  assert.match(
    normalBranch,
    /createArtifactGuideExtension\(\),\s*createAgentGuideExtension\(\),\s*\/\/ v0\.8\.2[\s\S]*?createCompactionModelExtension\(\),/,
  );
});

test("a chat workspace session wires the compaction extension", () => {
  assert.match(
    chatBranch,
    /createArtifactGuideExtension\(\),\s*createAgentGuideExtension\(\),\s*createCompactionModelExtension\(\),/,
  );
});

test("a resumed member session wires the compaction extension even without member built-ins", () => {
  // The guard used to be `builtins || usesExactSystemPrompt`: a snapshot predating the
  // member-extension names has builtins === undefined, and compaction silently vanished.
  // The hidden compaction extension registers no tools, so it does not change the old
  // snapshot's tool surface — widening the guard for it only restores the policy.
  assert.match(restoreBranch, /builtins \|\| usesExactSystemPrompt \|\| compactionEnabled/);
  assert.match(restoreBranch, /\.\.\.\(compactionEnabled \? \[createCompactionModelExtension\(\)\] : \[\]\)/);
});

test("a new member session wires both, including the guard for extension-less profiles", () => {
  assert.match(subagentRuntime, /const compactionEnabled = request\.lean !== true && !chatOnly;/);
  assert.match(
    subagentRuntime,
    /const baseSettingsManager = SettingsManager\.create\(childCwd, agentDir\);\s*const settingsManager = compactionEnabled\s*\?\s*createCompactionSettingsManager\(baseSettingsManager\)\s*:\s*baseSettingsManager;/,
  );
  assert.match(
    subagentRuntime,
    /memberBuiltins\.extensions\.length > 0 \|\| promptPlan\.exactSystemPrompt !== undefined \|\| compactionEnabled/,
  );
  assert.match(subagentRuntime, /\.\.\.\(compactionEnabled \? \[createCompactionModelExtension\(\)\] : \[\]\)/);
  // The wrapped manager is what services (and therefore the session) receives.
  assert.match(subagentRuntime, /settingsManager,\s*resourceLoaderOptions: \{/);
});

test("lean and chat-only sessions assemble neither the extension nor the wrapper", () => {
  // One predicate decides both assemblies in each file, so they can never drift apart.
  assert.match(startupSource, /const compactionEnabled = !chatOnly && !lean && !leanMember;/);
  assert.match(subagentRuntime, /const compactionEnabled = request\.lean !== true && !chatOnly;/);

  // A lean *member* is recognized from its snapshot, not from the global switch (which
  // never applies to subagent sessions). The snapshot field is written at spawn time.
  assert.match(startupSource, /const leanMember = subagentResources\?\.lean === true;/);
  assert.match(subagents, /const lean = isRecord\(snapshot\) && snapshot\.lean === true;/);
  assert.match(subagents, /\blean,\s*\n\s*\.\.\.\(typeof snapshot\.exactSystemPrompt/);
  assert.match(subagentRuntime, /lean: request\.lean === true,/);

  // chatOnly keeps exactly one inline extension (the exact prompt).
  assert.match(chatOnlyBranch, /extensionFactories: \[exactSystemPromptExtension\],/);
  assert.doesNotMatch(chatOnlyBranch, /createCompactionModelExtension|createCompactionSettingsManager/);

  // lean's resource-loader options are spread whole; they carry no inline factories.
  assert.match(startupSource, /resourceLoaderOptions: lean\s*\?\s*\{ \.\.\.LEAN_RESOURCE_LOADER_OPTIONS \}/);
  assert.doesNotMatch(leanMode, /extensionFactories|createCompaction/);

  // Exactly three factories in the startup path: chat workspace, normal session, and the
  // gated member-restore one. A fourth would mean compaction leaked into lean/chat-only.
  assert.equal(startupSource.match(/createCompactionModelExtension\(\)/g)?.length, 3);
  // One wrapper factory: the restored path must not wrap a second time.
  assert.equal(startupSource.match(/createCompactionSettingsManager\(/g)?.length, 1);
  // A lean member must not get the wrapper either: one predicate gates both.
  assert.match(
    startupSource,
    /const settingsManager = compactionEnabled\s*\?\s*createCompactionSettingsManager\(baseSettingsManager\)\s*:\s*baseSettingsManager;/,
  );
});

test("the compaction extension factory and wrapper still exist under the expected names", async () => {
  // Renaming either export must fail here rather than as a runtime ReferenceError inside
  // a session that only discovers it when compaction first runs.
  assert.match(rpcManager, /createCompactionModelExtension/);
  const compactionExtension = await read("./compaction-extension.ts");
  const compactionPolicy = await read("./compaction-policy.ts");
  assert.match(compactionExtension, /export function createCompactionModelExtension\(/);
  assert.match(compactionPolicy, /export function createCompactionSettingsManager\(/);
  // The execution extension only ever hooks the pre-compaction event.
  assert.match(compactionExtension, /pi\.on\("session_before_compact"/);
});