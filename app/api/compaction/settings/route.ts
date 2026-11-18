import { NextResponse } from "next/server";
import { getAgentDir, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { filterProvidersWithoutStoredCredential } from "@/lib/model-scope";
import {
  COMPACTION_LIMITS,
  defaultCompactionPolicy,
  readCompactionPolicy,
  toCompactionModelCandidates,
  validateCompactionPolicyPatch,
  writeCompactionPolicy,
  type CompactionModelCandidate,
  type CompactionPolicy,
} from "@/lib/compaction-settings-api";
import { compactionThresholdsByMode, type CompactionModeSummary } from "@/lib/compaction-policy";
import { createModelRuntimeWithExtensions } from "@/lib/model-runtime";

export const dynamic = "force-dynamic";

// Never surface an SDK/model error verbatim: it can carry provider details and
// file paths. The settings still load; only the candidate list is empty.
const CANDIDATES_UNAVAILABLE = "Model list is temporarily unavailable.";

/** The default model's real trigger per tier — the labels are only honest with these. */
interface CompactionTriggerSummary {
  model: string;
  contextWindow: number;
  modes: Record<"balanced" | "long" | "native", CompactionModeSummary>;
}

async function listCandidates(): Promise<{
  candidates: CompactionModelCandidate[];
  error?: string;
  runtime?: ModelRuntime;
}> {
  try {
    const modelRuntime = await createModelRuntimeWithExtensions();
    // 与对话选择器 / Settings›Models 同口径：内置 provider 没有 auth.json 存储凭据时
    // 不列它的模型（env token 不算凭据，见 e97dfb67），否则 compaction 模型选择器会
    // 显示用户根本用不了的内置模型。
    const models = await filterProvidersWithoutStoredCredential(
      await modelRuntime.getAvailable(),
      modelRuntime,
    );
    return { candidates: toCompactionModelCandidates(models), runtime: modelRuntime };
  } catch {
    return { candidates: [], error: CANDIDATES_UNAVAILABLE };
  }
}

/**
 * Thresholds for the default model, so the settings UI can say "balanced 50%"
 * and mean it. `null` when no default model is set or its window is unknown —
 * the block works without the hint.
 */
function triggerSummary(policy: CompactionPolicy, runtime: ModelRuntime): CompactionTriggerSummary | null {
  try {
    const settings = SettingsManager.create(getAgentDir(), getAgentDir());
    const provider = settings.getDefaultProvider();
    const modelId = settings.getDefaultModel();
    if (!provider || !modelId) return null;
    const model = runtime.getModel(provider, modelId);
    const contextWindow = model?.contextWindow ?? 0;
    if (!model || contextWindow <= 0) return null;
    return {
      model: `${provider}/${modelId}`,
      contextWindow,
      modes: compactionThresholdsByMode(settings, policy, model),
    };
  } catch {
    return null;
  }
}

export async function GET() {
  const policy = readCompactionPolicy();
  const { candidates, error, runtime } = await listCandidates();
  return NextResponse.json({
    policy,
    defaults: defaultCompactionPolicy(),
    limits: COMPACTION_LIMITS,
    candidates,
    thresholds: runtime ? triggerSummary(policy, runtime) : null,
    ...(error ? { candidatesError: error } : {}),
  });
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateCompactionPolicyPatch(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    return NextResponse.json({ policy: writeCompactionPolicy(validation.patch) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
