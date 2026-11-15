import { NextResponse } from "next/server";
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
} from "@/lib/compaction-settings-api";
import { createModelRuntimeWithExtensions } from "@/lib/model-runtime";

export const dynamic = "force-dynamic";

// Never surface an SDK/model error verbatim: it can carry provider details and
// file paths. The settings still load; only the candidate list is empty.
const CANDIDATES_UNAVAILABLE = "Model list is temporarily unavailable.";

async function listCandidates(): Promise<{ candidates: CompactionModelCandidate[]; error?: string }> {
  try {
    const modelRuntime = await createModelRuntimeWithExtensions();
    // 与对话选择器 / Settings›Models 同口径：内置 provider 没有 auth.json 存储凭据时
    // 不列它的模型（env token 不算凭据，见 e97dfb67），否则 compaction 模型选择器会
    // 显示用户根本用不了的内置模型。
    const models = await filterProvidersWithoutStoredCredential(
      await modelRuntime.getAvailable(),
      modelRuntime,
    );
    return { candidates: toCompactionModelCandidates(models) };
  } catch {
    return { candidates: [], error: CANDIDATES_UNAVAILABLE };
  }
}

export async function GET() {
  const policy = readCompactionPolicy();
  const { candidates, error } = await listCandidates();
  return NextResponse.json({
    policy,
    defaults: defaultCompactionPolicy(),
    limits: COMPACTION_LIMITS,
    candidates,
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
