import { NextResponse } from "next/server";
import { runNpx } from "@/lib/npx";
import type { SkillSearchResult } from "@/lib/api-types";
import { hasJsonContentType, isApiRequestAllowed, readJsonBody } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const ANSI_RE = /\x1B\[[0-9;]*m/g;
const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const SEARCH_API_BASE = process.env.SKILLS_API_URL || "https://skills.sh";

interface SkillsApiSkill {
  id?: string;
  name?: string;
  source?: string;
  installs?: number;
}

interface SkillsApiResponse {
  skills?: SkillsApiSkill[];
}

function parseLimit(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  // Number(null) / Number("") 都是 0（有限数）：缺省或空值不能当成「用户给了 0」，
  // 否则会被下面的 MIN_LIMIT 夹成每页 1 条。必须显式要求 > 0 才采信，否则回落默认值。
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(num)));
}

function formatInstalls(count?: number): string {
  if (!count || count <= 0) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M installs`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K installs`;
  return `${count} install${count === 1 ? "" : "s"}`;
}

function parseSearchOutput(raw: string): SkillSearchResult[] {
  const clean = raw.replace(ANSI_RE, "");
  const results: SkillSearchResult[] = [];
  const lines = clean.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // package line: "owner/repo@skill  NNK installs"
    const pkgMatch = line.match(/^([\w.\-]+\/[\w.\-@:]+)\s+([\d.,]+[KMB]?\s+installs)$/);
    if (pkgMatch) {
      const urlLine = lines[i + 1]?.trim().replace(/^└\s*/, "");
      results.push({
        package: pkgMatch[1],
        installs: pkgMatch[2],
        url: urlLine?.startsWith("https://") ? urlLine : "",
      });
    }
  }
  return results;
}

async function searchSkillsApi(query: string, limit: number): Promise<SkillSearchResult[]> {
  const url = `${SEARCH_API_BASE}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  // 外部搜索必须有超时：skills.sh 不可达但不是立即 RST（DNS 黑洞/丢包）时，无 signal 的
  // await 会一直挂起（undici headersTimeout 默认 300s），下面的 npx 兜底永远触发不到。
  // 超时让 fetch 抛 AbortError，落进调用方的 npx 兜底分支。
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`skills.sh search failed: HTTP ${res.status}`);

  const data = (await res.json()) as SkillsApiResponse;
  return (data.skills ?? [])
    .map((skill) => {
      const name = skill.name?.trim();
      const source = skill.source?.trim();
      const slug = skill.id?.trim();
      if (!name || (!source && !slug)) return null;

      const pkg = `${source || slug}@${name}`;
      return {
        package: pkg,
        installs: formatInstalls(skill.installs),
        url: slug ? `${SEARCH_API_BASE}/${slug}` : "",
      };
    })
    .filter((skill): skill is SkillSearchResult => skill !== null)
    .sort((a, b) => parseInstallCount(b.installs) - parseInstallCount(a.installs));
}

function parseInstallCount(installs: string): number {
  const match = installs.match(/^([\d.]+)([KMB])?\s+installs?$/);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const multiplier = match[2] === "B" ? 1_000_000_000 : match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1_000 : 1;
  return value * multiplier;
}

// POST /api/skills/search  body: { query: string, limit?: number }
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const read = await readJsonBody(req);
    if (!read.ok) return read.response;
    const parsed: unknown = read.body;
    // 解构 `null` 会抛 TypeError，而这里的 catch 是「API 搜索失败 → 退回 npx」的
    // 兜底分支：它会把内部 TypeError 原文当成 500 的 error 回给前端，状态码也错。
    // 形状不对本身就是 400。
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
    }
    const { query, limit: rawLimit } = parsed as { query?: string; limit?: unknown };
    if (!query?.trim()) return NextResponse.json({ error: "query required" }, { status: 400 });
    const limit = parseLimit(rawLimit);

    try {
      const results = await searchSkillsApi(query.trim(), limit);
      return NextResponse.json({ results });
    } catch {
      const { stdout, stderr } = await runNpx(["skills", "find", query.trim()], {
        timeout: 20000,
      });

      const results = parseSearchOutput(stdout + stderr).slice(0, limit);
      return NextResponse.json({ results });
    }
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const raw = (err.stdout ?? "") + (err.stderr ?? "");
    const results = raw ? parseSearchOutput(raw) : [];
    if (results.length > 0) return NextResponse.json({ results });
    return NextResponse.json({ error: err.message ?? String(e) }, { status: 500 });
  }
}
