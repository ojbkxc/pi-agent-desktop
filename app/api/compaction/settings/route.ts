import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
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
    return { candidates: toCompactionModelCandidates(await modelRuntime.getAvailable()) };
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
