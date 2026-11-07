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
  const [catalog, setCatalog] = useState<ModelCatalog>(EMPTY_MODEL_CATALOG);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    (async () => {
      try {
        const [modelsResponse, enabledResponse] = await Promise.all([
          fetch(`/api/models${query}`, { cache: "no-store" }),
          fetch(`/api/models/enabled${query}`, { cache: "no-store" }).catch(() => null),
        ]);
        if (!modelsResponse.ok) throw new Error(`HTTP ${modelsResponse.status}`);
        const modelsPayload = await modelsResponse.json() as unknown;
        const enabledPayload = enabledResponse && enabledResponse.ok
          ? await enabledResponse.json() as unknown
          : null;
        if (cancelled) return;
        setCatalog(buildModelCatalog(modelsPayload, enabledPayload));
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
