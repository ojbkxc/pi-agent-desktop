import { existsSync, rmSync, statSync } from "fs";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isChatFolderPath, isChatWorkspacePath } from "@/lib/chat-workspace";
import { allowFileRoot } from "@/lib/file-access";
import { forgetChatSystemPrompt } from "@/lib/chat-continue";
import { getRpcSession } from "@/lib/rpc-manager";
import {
  invalidateSessionListCache,
  readSessionHeader,
  resolveSessionPath,
} from "@/lib/session-reader";
import { appendClearedSessionToolSelection } from "@/lib/session-tool-selection";
import { hasJsonContentType, isApiRequestAllowed, readJsonBody } from "@/lib/request-security";

export const runtime = "nodejs";

/**
 * Continue a chat inside a project: the conversation is copied into a new session whose
 * cwd is the chosen project, so the model gains that project's tools while the chat stays
 * exactly as it was. The copy records the chat as its parent, like a fork.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const read = await readJsonBody(req);
    if (!read.ok) return read.response;
    const body = read.body as { cwd?: unknown };
    if (typeof body.cwd !== "string" || !body.cwd.trim()) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    const cwd = resolve(body.cwd);
    if (isChatWorkspacePath(cwd)) {
      return NextResponse.json({ error: "Choose a project folder" }, { status: 400 });
    }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const header = readSessionHeader(filePath);
    if (!header || !isChatWorkspacePath(header.cwd)) {
      return NextResponse.json({ error: "Only a chat can be continued in a project" }, { status: 400 });
    }
    if (getRpcSession(id)?.isRunning()) {
      return NextResponse.json({ error: "Wait for the chat to finish first" }, { status: 409 });
    }

    const manager = SessionManager.forkFrom(filePath, cwd);
    // An older chat's transcript pins an empty tool list; the project session follows its own settings.
    appendClearedSessionToolSelection(manager);
    // pi restores the tool loadout the transcript declares, which for a chat is `read` and
    // `codemode` only, so the chat's system messages stay behind.
    const copiedFile = manager.getSessionFile();
    if (copiedFile) {
      try {
        await forgetChatSystemPrompt(copiedFile);
      } catch (error) {
        // A copy that still carries the chat's prompt and tool limits would be a broken project session.
        rmSync(copiedFile, { force: true });
        throw error;
      }
    }
    allowFileRoot(cwd);
    invalidateSessionListCache();
    return NextResponse.json({
      sessionId: manager.getSessionId(),
      path: manager.getSessionFile() ?? null,
      cwd,
      // Files the chat made stay in its folder; the project session starts without them.
      chatFolder: isChatFolderPath(header.cwd) ? header.cwd : null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/**
 * Remove the system messages from a copied transcript, joining the entries around them.
 * 实现在 lib/chat-continue.ts（流式两遍，便于单测；数据/测试审计 A-4）。
 */
