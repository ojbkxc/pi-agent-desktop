import { existsSync } from "fs";
import { stat } from "fs/promises";
import { resolve } from "path";
import { createAgentSessionServices, getAgentDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  loadModelsWithCache,
  withModelRuntimeError,
  withSafeModelLoadFailure,
  type ModelsData,
} from "@/lib/models-cache";
import { orderSelectorModels, resolveVisibleModels, selectInitialModelScope } from "@/lib/model-scope";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { projectTrustReloadOptions } from "@/lib/project-trust";
import { chatWorkspaceDir, isChatFolderPath, isChatWorkspacePath } from "@/lib/chat-workspace";
import { readChatSettings, resolveChatStartDefaults } from "@/lib/chat-settings";
import { llamaCppExtension } from "@/lib/pi-sdk-internals";
import { providerDisplayNames, rememberProviderModels, withDeferredProviderModels } from "@/lib/deferred-provider-models";
import { inferRemovedWorktree } from "@/lib/worktree";
import { cwdMissingBody } from "@/lib/missing-cwd";

export const dynamic = "force-dynamic";

async function loadModels(cwd: string): Promise<ModelsData> {
  const nameMap = new Map<string, string>();
  let modelList: { id: string; name: string; provider: string; providerName: string }[] = [];
  let defaultModel: { provider: string; modelId: string } | null = null;
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};

  const agentDir = getAgentDir();
  // Gate untrusted project extensions: enumerating models still imports and
  // runs a repository's .pi/extensions factories, so honor project trust here
  // too (see lib/project-trust.ts, #236).
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    // llama.cpp is registered by an inline factory, not a file extension; the
    // picker needs its models like the session and auth routes have them.
    resourceLoaderOptions: { extensionFactories: [llamaCppExtension] },
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
  const modelError = services.modelRuntime.getError();
  const settings: SettingsManager = services.settingsManager;
  await rememberProviderModels(services.modelRuntime);
  // `enabledModels` supports globs and fuzzy patterns, so resolve it the same
  // way the CLI does instead of comparing pattern strings literally (#307).
  const scope = await resolveVisibleModels(
    withDeferredProviderModels(services.modelRuntime),
    settings.getEnabledModels(),
  );
  const { visible, thinkingLevelPins, warnings } = scope;
  const providerNames = providerDisplayNames(services.modelRuntime);
  modelList = orderSelectorModels(scope).map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    providerName: providerNames.get(m.provider) ?? m.provider,
    input: m.input,
  }));
  for (const m of visible) {
    const key = `${m.provider}:${m.id}`;
    nameMap.set(key, m.name);
    thinkingLevels[key] = getSupportedThinkingLevels(m);
    if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
  }

  const defaultProvider = settings.getDefaultProvider();
  const defaultModelId = settings.getDefaultModel();
  // A new chat starts on the model and reasoning level chosen in Settings › Chats, so the
  // composer must show the same ones the server will start with.
  const chatStart = isChatWorkspacePath(cwd)
    ? resolveChatStartDefaults(readChatSettings(), visible)
    : {};
  const initial = selectInitialModelScope(scope, {
    ...(chatStart.requestedModel ? { requestedModel: chatStart.requestedModel } : {}),
    ...(chatStart.thinkingLevel ? { thinkingLevel: chatStart.thinkingLevel } : {}),
    ...(defaultProvider && defaultModelId
      ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
      : {}),
  });
  if (initial.model) {
    defaultModel = { provider: initial.model.provider, modelId: initial.model.id };
  }
  const defaultThinkingLevel = initial.thinkingLevel
    ?? (initial.model
      ? settings.getModelThinkingLevel(initial.model.provider, initial.model.id)
      : undefined)
    ?? settings.getDefaultThinkingLevel()
    ?? null;

  return withModelRuntimeError(
    {
      models: Object.fromEntries(nameMap),
      modelList,
      defaultModel,
      defaultThinkingLevel,
      savedDefaultThinkingLevel: settings.getDefaultThinkingLevel() ?? null,
      thinkingLevels,
      thinkingLevelMaps,
      thinkingLevelPins,
      ...(warnings.length > 0 ? { modelScopeWarnings: warnings } : {}),
    },
    modelError,
  );
}

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  defaultThinkingLevel: null,
  savedDefaultThinkingLevel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
};

export async function GET(req: Request) {
  // 不带 ?cwd 时退回进程 cwd（网页版=仓库根，可过白名单，行为不变）。打包版下进程 cwd 是
  // 安装包内部（`resources/server`），永远不在白名单里——所以下面把「没给 cwd」和「给了但
  // 不允许」分开报：前者 400（调用方必须说明项目目录），后者 403。
  const rawCwd = new URL(req.url).searchParams.get("cwd");
  const requestedCwd = resolve(rawCwd || process.cwd());
  // A subagent run isolated in a worktree has that worktree removed when the run
  // finishes, yet its session file still records the worktree as its cwd. Fall back
  // to the main repo it branched from, so opening a finished subagent resolves the
  // same models a non-isolated one would. The roots check below runs on the folder
  // actually answered from, so the fallback reaches no project that was not allowed
  // by name already.
  const cwd = existsSync(requestedCwd)
    ? requestedCwd
    : inferRemovedWorktree(requestedCwd)?.projectRoot ?? requestedCwd;

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    // Typed: a moved project's session is not a model problem (#1422).
    return Response.json(cwdMissingBody(cwd), { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return Response.json(
      rawCwd
        ? { error: "Access denied" }
        : { error: "Access denied: no ?cwd given, and this process's working directory is not an allowed project folder" },
      { status: rawCwd ? 403 : 400 },
    );
  }

  try {
    // Every chat folder gets the same list (same chat policy, no project config), so they
    // share the chat root's entry instead of a cold load for each chat opened.
    const cacheKey = isChatFolderPath(cwd) ? chatWorkspaceDir() : cwd;
    return Response.json(await loadModelsWithCache(cacheKey, () => loadModels(cwd)));
  } catch {
    return Response.json(withSafeModelLoadFailure(EMPTY_MODELS));
  }
}
