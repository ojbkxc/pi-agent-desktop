import { NextResponse } from "next/server";
import {
  hasJsonContentType,
  isApiRequestAllowed,
  readJsonBody,
} from "@/lib/request-security";
import {
  PROMPT_OPTIMIZE_MAX_CHARS,
  runOptimizePrompt,
} from "@/lib/prompt-optimize-server";
import { isOptimizablePrompt } from "@/lib/prompt-optimize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/sessions/[id]/optimize-prompt  body: { requestId, prompt }
// Optimize the prompt with the session's current model and return the result.
export async function POST(req: Request, { params }: RouteParams) {
  const { id } = await params;
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json(
      { error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }
  try {
    const read = await readJsonBody(req);
    if (!read.ok) return read.response;
    const body = read.body as { requestId?: unknown; prompt?: unknown };
    if (typeof body.requestId !== "string" || !body.requestId.trim()) {
      return NextResponse.json(
        { error: "requestId is required" },
        { status: 400 },
      );
    }
    if (typeof body.prompt !== "string") {
      return NextResponse.json(
        { error: "prompt is required" },
        { status: 400 },
      );
    }
    const prompt = body.prompt;
    if (!isOptimizablePrompt(prompt)) {
      return NextResponse.json(
        { error: "Prompt must be non-empty and must not start with /" },
        { status: 400 },
      );
    }
    if (prompt.trim().length > PROMPT_OPTIMIZE_MAX_CHARS) {
      return NextResponse.json(
        { error: "Prompt is too long" },
        { status: 413 },
      );
    }

    const optimizedPrompt = await runOptimizePrompt(
      id,
      { requestId: body.requestId, prompt },
      req.signal,
    );
    return NextResponse.json({
      requestId: body.requestId,
      optimizedPrompt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Client aborted: not an error worth reporting as 500.
    if (req.signal.aborted) {
      return NextResponse.json(
        { error: "Prompt optimization cancelled", code: "PROMPT_OPTIMIZE_CANCELLED" },
        { status: 499 },
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
