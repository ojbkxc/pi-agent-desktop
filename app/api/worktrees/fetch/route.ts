import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { fetchRemote, listLocalBranches, listRemoteBranches, partitionBranchList, resolveProject } from "@/lib/worktree";
import { isCwdAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

// POST /api/worktrees/fetch  body: { cwd }  →  { branches, remoteBranches }
// Runs `git fetch --prune` and returns the fresh branch lists so the switcher
// shows remote branches that were pushed since the last look.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as { cwd?: string };
    if (!body.cwd || typeof body.cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!(await isCwdAllowed(body.cwd))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    await fetchRemote(body.cwd);

    const base = existsSync(body.cwd) ? body.cwd : (await resolveProject(body.cwd)).projectRoot;
    const [local, remote] = await Promise.all([listLocalBranches(base), listRemoteBranches(base)]);
    const { local: branches, remoteOnly: remoteBranches } = partitionBranchList(local, remote);
    return NextResponse.json({ success: true, branches, remoteBranches });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
