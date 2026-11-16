import { NextResponse } from "next/server";
import { listBackgroundJobs, getBackgroundJob, stopJobFromTool } from "@/lib/background-jobs/service";
import { jobOutputPath, readOutput } from "@/lib/background-jobs/store";

export const dynamic = "force-dynamic";

// GET /api/background-jobs            — every background command, newest first
// GET /api/background-jobs?id=<id>   — one job plus the last part of its output
//
// Read-only. The tools (bash_background / get_background_job / stop_background_job) are
// the model's path; this route is the UI's and the phone's.
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  try {
    if (id) {
      const job = getBackgroundJob(id);
      if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
      // Tail only: a build log can be megabytes, and the list view never shows the whole file.
      const tail = readOutput(id, undefined, 64 * 1024);
      return NextResponse.json({ job, tail, logPath: jobOutputPath(id) }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ jobs: listBackgroundJobs() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

// POST /api/background-jobs?id=<id> — stop a running job and its process tree.
// A job that already finished returns 409 rather than pretending it stopped.
export async function POST(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    const job = stopJobFromTool(id);
    if (!job) return NextResponse.json({ error: "no running job with that id" }, { status: 409 });
    return NextResponse.json({ job }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}