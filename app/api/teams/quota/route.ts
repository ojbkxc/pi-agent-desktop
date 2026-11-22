import { NextResponse } from "next/server";
import {
  TEAM_QUOTA_DEFAULTS,
  TEAM_QUOTA_RANGES,
  readGlobalRosterWorkers,
  readTeamQuotaResolution,
  readTeamSpawnConcurrency,
  writeTeamQuotaSettings,
} from "@/lib/agent-teams-swimlane-store";

export const dynamic = "force-dynamic";

/**
 * GET  /api/teams/quota —— 当前生效的团队并发上限 + 每个数字的来源（只读、零写盘）。
 * PUT  /api/teams/quota —— 改设置项 `teamQuota`（pi-web/settings.json，与 autopilot 同文件同风格）。
 *
 * body(PUT): { perTeamLimit?: number, globalLimit?: number }
 * 返回: { quota: { perTeamLimit, globalLimit }, sources, envNames, defaults, ranges,
 *         spawnConcurrency, globalWorkers, saved?: {...} }
 *
 * 优先级 env > 设置项 > 默认值（理由见 lib/agent-teams-swimlane-store.ts 配额段注释）：
 * 设置页写值后若 sources 仍是 "env"，说明被环境变量顶掉——文案要如实提示，
 * 不能让人以为「改了不生效」是 bug。
 */

const SOURCE_HINTS: Record<string, string> = {
  env: "由环境变量决定（优先级最高，改设置项不会生效；要改请改环境变量并重启）",
  settings: "由设置项 teamQuota 决定（PUT 本接口可改，立即生效、不必重启）",
  default: "默认值（未设 env，也未写过设置项）",
};

async function snapshot() {
  const resolution = readTeamQuotaResolution();
  let globalWorkers: number | null = null;
  try {
    globalWorkers = (await readGlobalRosterWorkers()).total;
  } catch {
    // 读名册失败只损「已用」这一格，不影响上限口径（不假装 0）。
    globalWorkers = null;
  }
  return {
    quota: { perTeamLimit: resolution.perTeamLimit, globalLimit: resolution.globalLimit },
    sources: resolution.sources,
    sourceHints: {
      perTeamLimit: SOURCE_HINTS[resolution.sources.perTeamLimit],
      globalLimit: SOURCE_HINTS[resolution.sources.globalLimit],
    },
    envNames: resolution.envNames,
    defaults: { ...TEAM_QUOTA_DEFAULTS },
    ranges: { ...TEAM_QUOTA_RANGES },
    spawnConcurrency: readTeamSpawnConcurrency(),
    globalWorkers,
  };
}

export async function GET() {
  return NextResponse.json(await snapshot(), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  }
  const record = body as Record<string, unknown>;
  const patch: { perTeamLimit?: number; globalLimit?: number } = {};
  for (const key of ["perTeamLimit", "globalLimit"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    const range = TEAM_QUOTA_RANGES[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) {
      return NextResponse.json(
        { error: `${key} 必须是 ${range.min}..${range.max} 的整数（收到 ${JSON.stringify(value)}）` },
        { status: 400 },
      );
    }
    patch[key] = value;
  }
  if (patch.perTeamLimit === undefined && patch.globalLimit === undefined) {
    return NextResponse.json({ error: "perTeamLimit 与 globalLimit 至少给一个" }, { status: 400 });
  }

  let saved: { perTeamLimit?: number; globalLimit?: number };
  try {
    saved = writeTeamQuotaSettings(patch);
  } catch (error) {
    // 落盘失败（权限/磁盘）如实 500，不谎报已保存。
    return NextResponse.json(
      { error: `写入设置失败：${error instanceof Error ? error.message : String(error)}` },
      { status: 500 },
    );
  }

  const current = await snapshot();
  // 写进去了却被 env 顶掉是**正常但必须说清**的状态：saved 是落盘值，quota 是生效值。
  const overridden = (["perTeamLimit", "globalLimit"] as const)
    .filter((key) => patch[key] !== undefined && current.sources[key] === "env");
  return NextResponse.json(
    {
      ...current,
      saved,
      ...(overridden.length > 0
        ? {
          warning: `${overridden.join("、")} 已写入设置，但当前被环境变量 ${
            overridden.map((key) => current.envNames[key]).join("、")
          } 覆盖，生效值以上面的 quota 为准；要按设置生效请去掉对应环境变量。`,
        }
        : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
