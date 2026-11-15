import {
  createAgentSessionServices,
  getAgentDir,
  SettingsManager,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

/**
 * ModelRuntime that also includes providers registered by extensions (an
 * extension that calls `registerProvider` / `createProvider` during resource
 * loading). A bare `ModelRuntime.create()` only knows built-in providers plus
 * models.json, so extension-registered providers were invisible to the
 * provider-listing and auth routes.
 *
 * The agent dir acts as cwd so project-local extensions stay out; global
 * package extensions always load. Not cached: these routes need fresh
 * credentials for auth status and login/logout to be truthful.
 */
export async function createModelRuntimeWithExtensions(
  modelRuntime?: ModelRuntime,
): Promise<ModelRuntime> {
  const agentDir = getAgentDir();
  const runtime = modelRuntime ?? await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const services = await createAgentSessionServices({
    cwd: agentDir,
    agentDir,
    modelRuntime: runtime,
    resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
  });
  return services.modelRuntime;
}

// SettingsManager queues its first `deviceId` write, so a second login in this
// process that read the file again first would find no `deviceId` and mint
// another UUID. pi-ai documents the getter as "must return the same ID on every
// later call", so cache one per agent dir (fork layer; upstream #1526 creates a
// fresh SettingsManager per login, which re-reads the not-yet-written file).
const loginSettingsManagers = new Map<string, ReturnType<typeof SettingsManager.create>>();

/**
 * The options pi's TUI passes to `ModelRuntime.login()`. Sign in with ChatGPT
 * (the `openai` provider's OAuth) refuses to start without this installation's
 * device ID; pi creates it on first use and keeps it as `deviceId` in the
 * global settings.json, so the TUI and Pi Web sign in as the same host.
 * `flush()` waits for that first write.
 */
export function createLoginOptions(agentDir = getAgentDir()) {
  let settingsManager = loginSettingsManagers.get(agentDir);
  if (!settingsManager) {
    settingsManager = SettingsManager.create(agentDir, agentDir);
    loginSettingsManagers.set(agentDir, settingsManager);
  }
  return {
    options: { getDeviceId: () => settingsManager.getOrCreateDeviceId() },
    flush: () => settingsManager.flush(),
  };
}
