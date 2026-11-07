import { NextResponse } from "next/server";
import { createReadStream, createWriteStream, existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { createInterface } from "readline";
import { dirname, join } from "path";
import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
  openSessionManager,
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  invalidateSessionManagerCache,
  buildSessionContext,
  readSessionHeader,
  readSessionSubagentScanEntries,
} from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { abortSubagent, getRpcSession, getRpcSessionInfos } from "@/lib/rpc-manager";
import { projectTreeForResponse, toSummaryTree } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { computeSessionStats } from "@/lib/session-stats";
import { startServerPerf } from "@/lib/perf";
import { computeSessionRevision } from "@/lib/session-revision";
import type { SessionEntry } from "@/lib/types";
import { readSubagentRun, readSubagentSessionResources, SUBAGENT_META_TYPE } from "@/lib/subagents";
import { readSessionToolSelection } from "@/lib/session-tool-selection";
import { jsonResponse } from "@/lib/json-response";
import { isChatFolderPath } from "@/lib/chat-workspace";
import { samePath } from "@/lib/paths";
import { moveFolderToTrash } from "@/lib/trash";
import { disposeComposerQueueState } from "@/lib/composer-queue";
import { replaceFileAtomicStream } from "@/lib/atomic-file";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const perf = startServerPerf("GET /api/sessions/[id]");
  try {
    perf?.span("resolve");
    const rpc = getRpcSession(id);
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";

    // A live wrapper only reflects the appends pi-web itself made. When another
    // pi process (the TUI) writes the same session file, the in-memory index
    // stays stale. Only probe on ?force=1 (session mount / page refresh): two
    // processes writing one JSONL is unsupported, so post-turn reads must not
    // scan disk. Eviction is idle-only; mid-run the wrapper owns the write path.
    let liveWrapper = rpc?.isAlive() ? rpc : undefined;
    let wrapperRebuilt = false;
    if (force && liveWrapper?.evictIfDiskAhead()) {
      wrapperRebuilt = true;
      liveWrapper = undefined;
    }
    const liveRpc = liveWrapper;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? openSessionManager(resolvedPath!);
    perf?.span("open");
    const filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || "";
    const entries = sm.getEntries();
    const leafId = sm.getLeafId();
    const summaryTree = searchParams.get("tree") === "summary";
    const tree = summaryTree
      ? toSummaryTree(projectTreeForResponse(sm.getTree()))
      : projectTreeForResponse(sm.getTree());
    perf?.span("tree");
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const rawTail = Number(searchParams.get("tail"));
    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
    // Chat-view loads ask for whole turns; the default keeps `tail` an exact cap.
    const wholeTurns = searchParams.has("wholeTurns");
    const context = buildSessionContext(entries as never, leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      wholeTurns,
      sessionId: id, // local: lazy URLs for historical tool-result images
    });
    perf?.span("context");
    const totalActiveMs = computeSessionTotalActiveMs(entries);
    // Cumulative usage over ALL entries, including history compacted away —
    // the same aggregation the SDK's getSessionStats() uses. Lets the client
    // keep monotonic token/cost counters across compaction and page reloads.
    const stats = computeSessionStats(entries as unknown as SessionEntry[]);
    perf?.span("stats");
    // Opaque freshness token for the session view cache. Derived from the
    // disk fingerprint and the actual read source; null tells the client the
    // snapshot is unstable and must not be cached as fresh.
    const latestEntry = entries[entries.length - 1] as { id?: string } | undefined;
    const snapshotRevision = computeSessionRevision({
      filePath,
      sourceId: liveRpc ? `runtime:${String(liveRpc.inner.sessionId)}` : "disk",
      entryCount: entries.length,
      latestEntryId: typeof latestEntry?.id === "string" ? latestEntry.id : null,
      leafId: leafId ?? null,
    });
    const sessionName = sm.getSessionName();
    const firstUserEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
    const firstUserMessage = firstUserEntry?.type === "message" ? firstUserEntry.message : undefined;

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const subagent = header
      ? readSubagentRun(entries as never, header.id, filePath)
      : null;
    const toolNames = readSubagentSessionResources(entries as never)?.tools
      ?? readSessionToolSelection(entries as never);
    const info = header ? (await attachSessionProjectInfo([{
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sessionName,
      created: header.timestamp,
      modified,
      messageCount: stats.totalMessages,
      firstMessage: firstUserMessage
        ? (() => {
            const c = (firstUserMessage as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
      ...(subagent
        ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: liveRpc?.isRunning() ? "running" as const : subagent.status } }
        : header.parentSession
          ? { relation: { kind: "fork" as const, ...(parentSessionId ? { originSessionId: parentSessionId } : {}) } }
          : {}),
      transient: !filePath || !existsSync(filePath),
    }]))[0] : null;

    return perf?.attach(jsonResponse(
      req,
      {
        sessionId: id,
        filePath,
        info,
        leafId,
        tree,
        ...(summaryTree ? { treeFormat: "summary" as const } : {}),
        snapshotRevision,
        context,
        stats,
        totalActiveMs,
        ...(toolNames !== undefined ? { toolNames } : {}),
        ...(wrapperRebuilt ? { wrapperRebuilt: true } : {}),
      },
    )) ?? jsonResponse(
      req,
      {
        sessionId: id,
        filePath,
        info,
        leafId,
        tree,
        ...(summaryTree ? { treeFormat: "summary" as const } : {}),
        snapshotRevision,
        context,
        stats,
        totalActiveMs,
        ...(toolNames !== undefined ? { toolNames } : {}),
        ...(wrapperRebuilt ? { wrapperRebuilt: true } : {}),
      },
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // A live session owns its file: a second manager appending behind its back
    // leaves the live one (and GET, which reads it) on the old name, and hangs
    // the entry off a leaf the live tree has moved past. Before the first flush
    // the file is also a stub the runtime is about to write over. So whenever
    // the session is live, let its own manager record the name. Unlike the
    // set_session_name command this accepts "", which clears the title.
    const live = getRpcSession(id);
    if (live?.isAlive()) {
      live.inner.setSessionName(name.trim());
      invalidateSessionListCache();
      return NextResponse.json({ ok: true });
    }
    if (!existsSync(filePath)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // PATCH writes via appendSessionInfo — open fresh, bypassing the cache.
    const sm = openSessionManager(filePath, { mutable: true });
    sm.appendSessionInfo(name.trim());
    invalidateSessionManagerCache(filePath);
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
// ?chatFolder=trash also moves a chat's own folder to the Trash, unless another session
// (a fork shares its parent's folder) still lives there.

/**
 * Re-point a session file at a new parent: rewrite the header's
 * `parentSession` and, when re-parenting into a live session id, the first
 * SUBAGENT_META entry's `parentSessionId`/`parentSessionPath`. Every other
 * line passes through untouched. Streams line by line so an 82 MB transcript
 * is never held in memory (the old whole-file readFileSync stopped the event
 * loop once per deleted child); the swap itself is replaceFileAtomicStream's,
 * so the symlink target, permission bits, an fsync before the rename and temp
 * cleanup on failure all match the string form.
 */
async function reattachSessionFile(
  childPath: string,
  rewrite: { header: { parentSession?: string }; parentSessionPath: string | undefined; parentSessionId?: string },
): Promise<void> {
  await replaceFileAtomicStream(childPath, async (tempPath) => {
    // The temp file already exists ("wx"/0600, created by the helper), so the
    // write stream appends instead of truncating.
    const output = createWriteStream(tempPath, { flags: "r+", mode: 0o600 });
    const input = createReadStream(childPath, "utf8");
    const lines = createInterface({ input, crlfDelay: Infinity });
    let lineIndex = 0;
    let metaReplaced = false;
    try {
      for await (const line of lines) {
        if (lineIndex === 0) {
          // Re-parent (or un-parent) the header. Without a new parent the key
          // is omitted entirely: the baseline never wrote `parentSession: ""`,
          // and the old value points at the file being deleted anyway.
          const nextHeader: Record<string, unknown> = { ...rewrite.header };
          if (rewrite.parentSessionPath) nextHeader.parentSession = rewrite.parentSessionPath;
          else delete nextHeader.parentSession;
          output.write(`${JSON.stringify(nextHeader)}\n`);
        } else if (
          rewrite.parentSessionId
          && !metaReplaced
          && line.includes(SUBAGENT_META_TYPE)
        ) {
          let replaced = false;
          try {
            const entry = JSON.parse(line) as { type?: string; customType?: string; data?: unknown };
            if (
              entry.type === "custom"
              && entry.customType === SUBAGENT_META_TYPE
              && typeof entry.data === "object"
              && entry.data !== null
              && !Array.isArray(entry.data)
            ) {
              entry.data = { ...entry.data, parentSessionId: rewrite.parentSessionId, parentSessionPath: rewrite.parentSessionPath };
              output.write(`${JSON.stringify(entry)}\n`);
              replaced = true;
            }
          } catch { /* a torn line is copied as-is below */ }
          if (!replaced) output.write(`${line}\n`);
          else metaReplaced = true;
        } else {
          output.write(`${line}\n`);
        }
        lineIndex += 1;
      }
      await new Promise<void>((resolve, reject) => {
        output.end(() => resolve());
        output.on("error", reject);
      });
    } finally {
      lines.close();
      input.destroy();
      // A failure must not hold the temp file open: the helper's cleanup unlinks
      // it, which Windows refuses while a writer still has it open.
      if (!output.writableEnded) output.destroy();
    }
  });
}
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const trashChatFolder = new URL(req.url).searchParams.get("chatFolder") === "trash";
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Read only the bounded header before deleting.
    let parentSessionPath: string | undefined;
    let sessionCwd: string | undefined;
    try {
      const header = readSessionHeader(filePath);
      parentSessionPath = header?.parentSession;
      sessionCwd = header?.cwd;
    } catch (error) {
      // Empty runtime sessions have a cached path before their first disk write.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let parentSessionId: string | undefined;
    if (parentSessionPath) {
      try {
        // The parent may have been deleted or moved already; treat it as absent.
        parentSessionId = readSessionHeader(parentSessionPath)?.id;
      } catch {
        parentSessionId = undefined;
      }
    }

    const targetPathKey = sessionPathKey(filePath);
    const dir = dirname(filePath);
    // Deleting a session also deletes every persisted or live subagent below it.
    const sessions = mergeSessionLists(
      await listAllSessions({ force: true }),
      getRpcSessionInfos({ includeTransient: true }),
    );
    const childrenByParent = new Map<string, string[]>();
    for (const session of sessions) {
      if (session.relation?.kind !== "subagent") continue;
      const children = childrenByParent.get(session.relation.parentSessionId) ?? [];
      children.push(session.id);
      childrenByParent.set(session.relation.parentSessionId, children);
    }
    const sessionPaths = new Map(sessions.map((session) => [session.id, session.path]));
    // Include local files even when the global catalogue is stale or incomplete.
    try {
      for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl"))) {
        const childPath = join(dir, file);
        if (sessionPathKey(childPath) === targetPathKey) continue;
        try {
          // Bounded read (header lines + subagent tail): a sibling transcript
          // can be hundreds of MB, and this loop runs for every file in the
          // directory twice during a delete.
          const header = readSessionHeader(childPath);
          if (!header?.id) continue;
          const subagent = readSubagentRun(readSessionSubagentScanEntries(childPath), header.id, childPath);
          if (!subagent) continue;
          const children = childrenByParent.get(subagent.parentSessionId) ?? [];
          children.push(subagent.sessionId);
          childrenByParent.set(subagent.parentSessionId, children);
          sessionPaths.set(subagent.sessionId, childPath);
        } catch { /* skip malformed or concurrently removed sessions */ }
      }
    } catch { /* skip if dir unreadable */ }
    const deletedSessionIds = new Set<string>([id]);
    const pending = [id];
    while (pending.length > 0) {
      const parentId = pending.pop()!;
      for (const childId of childrenByParent.get(parentId) ?? []) {
        if (deletedSessionIds.has(childId)) continue;
        deletedSessionIds.add(childId);
        pending.push(childId);
      }
    }
    const deletedPaths = new Map<string, string>([[id, filePath]]);
    for (const deletedId of deletedSessionIds) {
      const sessionPath = sessionPaths.get(deletedId);
      if (sessionPath) deletedPaths.set(deletedId, sessionPath);
    }
    for (const deletedId of deletedSessionIds) {
      if (deletedPaths.has(deletedId)) continue;
      const runtimePath = getRpcSession(deletedId)?.sessionFile;
      if (runtimePath) deletedPaths.set(deletedId, runtimePath);
      else {
        const resolvedPath = await resolveSessionPath(deletedId);
        if (resolvedPath) deletedPaths.set(deletedId, resolvedPath);
      }
    }
    const deletedPathKeys = new Set([...deletedPaths.values()].map((path) => sessionPathKey(path)));

    // Re-attach all direct children to this session's parent (cascade re-parent)
    // Scan sibling files in the same directory
    try {
      const files = readdirSync(dir).filter(
        (file) => file.endsWith(".jsonl") && sessionPathKey(join(dir, file)) !== targetPathKey,
      );
      for (const file of files) {
        const childPath = join(dir, file);
        if (deletedPathKeys.has(sessionPathKey(childPath))) continue;
        try {
          // Bounded header read decides the rewrite; the file body itself is
          // streamed through a line-level rewrite instead of a whole-file
          // readFileSync (a sibling transcript can be hundreds of MB).
          const header = readSessionHeader(childPath);
          if (
            !header?.parentSession ||
            sessionPathKey(header.parentSession) !== targetPathKey
          ) continue;
          await reattachSessionFile(childPath, {
            header,
            parentSessionPath,
            ...(parentSessionPath && parentSessionId ? { parentSessionId } : {}),
          });
        } catch { /* skip malformed */ }
      }
    } catch { /* skip if dir unreadable */ }

    for (const deletedId of [...deletedSessionIds].reverse()) {
      if (deletedId === id) continue;
      try { await abortSubagent(deletedId); } catch { /* idle or completed */ }
      await getRpcSession(deletedId)?.shutdown();
    }
    try { await abortSubagent(id); } catch { /* ordinary session */ }
    await getRpcSession(id)?.shutdown();
    for (const [deletedId, deletedPath] of deletedPaths) {
      try {
        unlinkSync(deletedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      invalidateSessionPathCache(deletedId);
      invalidateSessionManagerCache(deletedPath);
      // The session file is gone: no reopen will ever deliver or read its outbox.
      disposeComposerQueueState(deletedId);
    }
    invalidateSessionListCache();
    let folderTrashed = false;
    if (trashChatFolder && sessionCwd && isChatFolderPath(sessionCwd) && existsSync(sessionCwd)) {
      const stillUsed = sessions.some((session) => (
        !deletedSessionIds.has(session.id) && session.cwd && samePath(session.cwd, sessionCwd)
      ));
      if (!stillUsed) {
        await moveFolderToTrash(sessionCwd);
        folderTrashed = true;
      }
    }
    return NextResponse.json({ ok: true, folderTrashed });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
