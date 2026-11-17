import { NextResponse } from "next/server";
import { getArtifact } from "@/lib/artifact-index";
import { listAllSessions } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

// 详情接口默认会返回每个版本的全部正文；一个被反复改写的大型 artifact（多版各数百
// KB）会在一次 GET 里全量下发（数据/测试审计 A-6）。给总正文设字节预算：超出时
// **从最旧的版本开始丢弃**，只保留能装下的最新若干版，并置 truncated + totalVersions。
// 响应形状不变（仍是 versions[]），组件只是少显示几个旧版本标签。
const MAX_CONTENT_BYTES = 4 * 1024 * 1024;

/** 估算一条版本正文的字节数（UTF-8）。 */
function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// GET ?session=&identifier=[&latest=1] — one artifact with every version's
// content, or only the newest (list thumbnails).
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const sessionId = params.get("session") ?? "";
  const identifier = params.get("identifier") ?? "";
  const latestOnly = params.get("latest") === "1";
  const headers = { "Cache-Control": "no-store" };
  if (!sessionId || !identifier) {
    return NextResponse.json({ error: "session and identifier are required" }, { status: 400, headers });
  }
  try {
    let session = (await listAllSessions({ allowStale: true })).find((item) => item.id === sessionId);
    // A session written since the stale catalogue was built.
    if (!session) session = (await listAllSessions()).find((item) => item.id === sessionId);
    const artifact = session && session.relation?.kind !== "subagent" ? await getArtifact(session, identifier) : null;
    if (!artifact) {
      return NextResponse.json({ error: "Artifact not found" }, { status: 404, headers });
    }
    const allVersions = latestOnly ? artifact.versions.slice(-1) : artifact.versions;
    // 从最新往前累加，装不下就停；之后按原顺序（时间升序）输出保留下来的版本。
    const kept: typeof allVersions = [];
    let budget = MAX_CONTENT_BYTES;
    for (let i = allVersions.length - 1; i >= 0; i--) {
      const cost = byteLength(allVersions[i].content ?? "");
      // 至少保留最新一版（即便它本身就超预算），避免空响应。
      if (kept.length > 0 && cost > budget) break;
      kept.unshift(allVersions[i]);
      budget -= cost;
    }
    const truncated = kept.length < allVersions.length;
    return NextResponse.json({
      identifier: artifact.identifier,
      totalVersions: allVersions.length,
      truncated,
      versions: kept.map((version) => ({
        entryId: version.entryId,
        timestamp: version.timestamp,
        title: version.title,
        type: version.type,
        lang: version.lang,
        content: version.content,
        complete: version.complete,
        onActiveBranch: version.onActiveBranch,
      })),
    }, { headers });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers });
  }
}
