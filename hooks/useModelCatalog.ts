"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 可选模型目录：把「有哪些模型」（GET /api/models 的 modelList）与「用户启用了哪些」
 * （GET /api/models/enabled 的 providers[].models[].enabled）合并成一份带 enabled 标记、
 * 按 provider 分组的目录，供模型多选选择器复用。
 *
 * 纯函数（buildModelCatalog 等）与 React hook 分离：合并逻辑可脱离 DOM 单测。
 * ref 一律是 `provider/modelId`，与 team_create 成员 model 参数同格式。
 */

export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  /** 'provider/modelId' —— 对外产出与 team_create 成员 model 参数一致。 */
  ref: string;
  enabled: boolean;
}

export interface ModelCatalogGroup {
  provider: string;
  models: ModelCatalogEntry[];
  enabledCount: number;
}

export interface ModelCatalog {
  /** 全部模型，按 name/id/provider 自然序。 */
  entries: ModelCatalogEntry[];
  /** 按 provider 分组（provider 名自然序）。 */
  groups: ModelCatalogGroup[];
  /** 已启用模型数量。 */
  enabledCount: number;
  /** 是否拿到了启用信息；为 false 时所有模型按「已启用」降级展示。 */
  hasEnabledInfo: boolean;
}

export const EMPTY_MODEL_CATALOG: ModelCatalog = {
  entries: [],
  groups: [],
  enabledCount: 0,
  hasEnabledInfo: false,
};

export interface ModelCatalogController {
  catalog: ModelCatalog;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * 模块级目录缓存。
 *
 * 为什么需要它（审批弹框「点几次才好」的根因）：模型下拉在
 * `disabled={!editable || catalog.loading}`，而 `loading` 初值是 `true`。`AppSelect`
 * 把 `disabled` 传给原生 `<button disabled>`，浏览器**根本不派发 click**，于是「打开
 * 弹框后马上点模型下拉」的第一下被整个吞掉，要等 `/api/models` 回来（几百毫秒，隧道下
 * 更久）再点才有反应。重开弹框会卸载 `PlanEditor` 再挂载，`loading` 复位，所以同一个
 * 窗口会反复出现——用户感受就是「要点几次」。
 *
 * 口径：按 cwd 键控、60 秒有效；`refresh()`（nonce 变化）永远绕过缓存重新拉取。它只让
 * **第二次及以后的挂载**不再经历一次加载窗口，不改变首次挂载与刷新的语义。
 */
const CATALOG_CACHE_TTL_MS = 60_000;
let catalogCache: { cwd: string | null; data: ModelCatalog; at: number } | null = null;

function readCatalogCache(cwd: string | null): ModelCatalog | null {
  if (!catalogCache) return null;
  if (catalogCache.cwd !== cwd) return null;
  if (Date.now() - catalogCache.at > CATALOG_CACHE_TTL_MS) return null;
  return catalogCache.data;
}

function writeCatalogCache(cwd: string | null, data: ModelCatalog): void {
  catalogCache = { cwd, data, at: Date.now() };
}

const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** 'provider/modelId'；provider 与 id 都可能自身含斜杠，故拼接不解析回拆。 */
export function modelRef(provider: string, id: string): string {
  return `${provider}/${id}`;
}

interface RawModel {
  id: string;
  name: string;
  provider: string;
}

/**
 * 容错解析 GET /api/models 的 modelList；非字符串字段、缺 id/provider 一律跳过。
 */
export function parseModelList(payload: unknown): RawModel[] {
  const list = payload && typeof payload === "object"
    ? (payload as { modelList?: unknown }).modelList
    : null;
  if (!Array.isArray(list)) return [];
  const out: RawModel[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { id, name, provider } = item as Record<string, unknown>;
    if (typeof id !== "string" || !id || typeof provider !== "string" || !provider) continue;
    out.push({ id, name: typeof name === "string" && name ? name : id, provider });
  }
  return out;
}

interface EnabledInfo {
  refs: Set<string>;
  /** 服务端表示「全部启用」（某个 glob 覆盖全部）时为 true。 */
  all: boolean;
}

/**
 * 解析 GET /api/models/enabled 的启用集合；结构不符返回 null（=没有启用信息，
 * 调用方据此降级为「全部按已启用展示」）。allEnabled 为 true 时全部算启用。
 */
export function parseEnabledInfo(payload: unknown): EnabledInfo | null {
  if (!payload || typeof payload !== "object") return null;
  const providers = (payload as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return null;
  const refs = new Set<string>();
  for (const provider of providers) {
    if (!provider || typeof provider !== "object") continue;
    const models = (provider as { models?: unknown }).models;
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      if (!model || typeof model !== "object") continue;
      const { ref, enabled } = model as Record<string, unknown>;
      if (typeof ref === "string" && enabled === true) refs.add(ref);
    }
  }
  return { refs, all: (payload as { allEnabled?: unknown }).allEnabled === true };
}

function compareEntries(a: ModelCatalogEntry, b: ModelCatalogEntry): number {
  return NAME_COLLATOR.compare(a.name || a.id, b.name || b.id)
    || NAME_COLLATOR.compare(a.provider, b.provider)
    || NAME_COLLATOR.compare(a.id, b.id);
}

/**
 * 合并两个端点成目录。enabledPayload 为空/结构不符时 hasEnabledInfo=false，
 * 所有模型按 enabled=true 降级（选择器据此隐藏「仅看已启用」）。
 */
export function buildModelCatalog(modelsPayload: unknown, enabledPayload: unknown): ModelCatalog {
  const rawModels = parseModelList(modelsPayload);
  const info = parseEnabledInfo(enabledPayload);
  const hasEnabledInfo = info !== null;

  const entries: ModelCatalogEntry[] = rawModels.map((model) => {
    const ref = modelRef(model.provider, model.id);
    const enabled = info === null ? true : (info.all || info.refs.has(ref));
    return { id: model.id, name: model.name, provider: model.provider, ref, enabled };
  }).sort(compareEntries);

  const byProvider = new Map<string, ModelCatalogEntry[]>();
  for (const entry of entries) {
    const list = byProvider.get(entry.provider);
    if (list) list.push(entry);
    else byProvider.set(entry.provider, [entry]);
  }
  const groups: ModelCatalogGroup[] = [...byProvider.entries()]
    .map(([provider, models]) => ({
      provider,
      models,
      enabledCount: models.filter((model) => model.enabled).length,
    }))
    .sort((a, b) => NAME_COLLATOR.compare(a.provider, b.provider));

  return {
    entries,
    groups,
    enabledCount: entries.filter((entry) => entry.enabled).length,
    hasEnabledInfo,
  };
}

/**
 * 拉取并合并模型目录。cwd 传给两个端点（缺省由服务端用 process.cwd()）。
 * 模型列表失败 → error + 空目录；启用端点失败只降级（不影响可选列表）。
 */
export function useModelCatalog(cwd?: string | null): ModelCatalogController {
  // 命中缓存就以 `loading=false` 起渲染：模型下拉立即可点，第一次点击不再被吞
  // （见上面 `catalogCache` 的注释）。未命中仍是原来的 `true`。
  const warm = readCatalogCache(cwd ?? null);
  const [catalog, setCatalog] = useState<ModelCatalog>(warm ?? EMPTY_MODEL_CATALOG);
  const [loading, setLoading] = useState(warm === null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // 缓存命中时**首轮不进加载态**：否则 effect 一跑就把 `loading` 拨回 true，模型下拉又
    // 变成 disabled、第一下点击继续被吞——缓存就白做了。只在这一轮（挂载后第一次 effect）
    // 且确实有同 cwd 缓存时跳过；`refresh()`（nonce 变化）与切 cwd 仍然照常置 loading。
    const servedFromCache = nonce === 0 && warm !== null;
    if (!servedFromCache) setLoading(true);
    setError(null);
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    // d5-24：远程/隧道访问下连接可能半开挂起——没有超时 loading 会永卡且同 cwd
    // 无自愈。20s 与服务端冷启动上限同量级，超时按失败呈现（切 cwd / refresh 重试）。
    const timeoutSignal = AbortSignal.timeout(20_000);
    (async () => {
      try {
        const [modelsResponse, enabledResponse] = await Promise.all([
          fetch(`/api/models${query}`, { cache: "no-store", signal: timeoutSignal }),
          fetch(`/api/models/enabled${query}`, { cache: "no-store", signal: timeoutSignal }).catch(() => null),
        ]);
        if (!modelsResponse.ok) throw new Error(`HTTP ${modelsResponse.status}`);
        const modelsPayload = await modelsResponse.json() as unknown;
        const enabledPayload = enabledResponse && enabledResponse.ok
          ? await enabledResponse.json() as unknown
          : null;
        if (cancelled) return;
        const next = buildModelCatalog(modelsPayload, enabledPayload);
        setCatalog(next);
        // 缓存只用于「下一次挂载不再走加载窗口」，不影响本次渲染。
        writeCatalogCache(cwd ?? null, next);
      } catch (err) {
        if (cancelled) return;
        setCatalog(EMPTY_MODEL_CATALOG);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [cwd, nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  return { catalog, loading, error, refresh };
}
