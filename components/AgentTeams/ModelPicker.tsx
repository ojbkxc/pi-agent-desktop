"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ModelCatalog, ModelCatalogEntry } from "@/hooks/useModelCatalog";

/**
 * 纯筛选：关键字匹配 name / id / provider；enabledOnly 只看已启用。
 * 导出以便脱离 DOM 单测。
 */
export function filterCatalogEntries(
  entries: ModelCatalogEntry[],
  query: string,
  enabledOnly: boolean,
): ModelCatalogEntry[] {
  const normalized = query.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (enabledOnly && !entry.enabled) return false;
    if (!normalized) return true;
    return `${entry.name} ${entry.id} ${entry.provider}`.toLocaleLowerCase().includes(normalized);
  });
}

/** 纯切换：已选则移除、未选则追加（保持既有顺序）。导出以便单测。 */
export function toggleModelRef(value: string[], ref: string): string[] {
  return value.includes(ref) ? value.filter((item) => item !== ref) : [...value, ref];
}

/**
 * 行点击后的新选中集：多选走 toggleModelRef；单选（single）点已选项取消、点别的项替换。
 * 导出以便单测。
 */
export function nextSelection(value: string[], ref: string, single: boolean): string[] {
  if (!single) return toggleModelRef(value, ref);
  return value.includes(ref) ? [] : [ref];
}

/**
 * Flash 档判定：模型 id 匹配 /flash/i。数据驱动，将来任何 provider 新增 flash
 * 模型都自动纳入，不需要改代码。
 */
export function isFlashModelId(id: string): boolean {
  return /flash/i.test(id);
}

/**
 * 当前可见集里的 Flash 档：refs 是它们的 ref，active 表示「已全部选中」。
 * 作用域是传入的可见集（受当前搜索/筛选影响），无 flash 项时 refs 为空。
 */
export function flashPresetState(
  visible: ModelCatalogEntry[],
  value: string[],
): { refs: string[]; active: boolean } {
  const refs = visible.filter((entry) => isFlashModelId(entry.id)).map((entry) => entry.ref);
  const selected = new Set(value);
  return { refs, active: refs.length > 0 && refs.every((ref) => selected.has(ref)) };
}

/** 按 provider 分组（保持传入顺序）。 */
function groupEntries(entries: ModelCatalogEntry[]): { provider: string; models: ModelCatalogEntry[] }[] {
  const groups: { provider: string; models: ModelCatalogEntry[] }[] = [];
  for (const entry of entries) {
    const group = groups.find((item) => item.provider === entry.provider);
    if (group) group.models.push(entry);
    else groups.push({ provider: entry.provider, models: [entry] });
  }
  return groups;
}

export interface ModelPickerProps {
  /** useModelCatalog() 产出的目录。 */
  catalog: ModelCatalog;
  /** 受控已选，元素为 'provider/modelId'。 */
  value: string[];
  onChange: (next: string[]) => void;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  ariaLabel?: string;
  /** 单选：点已选项取消、点别的项替换；此时不显示「Flash 全部」预设。 */
  single?: boolean;
}

/**
 * 可复用的模型多选选择器：按 provider 分组平铺全部模型，勾选产出 'provider/modelId'
 * 列表（与 team_create 成员 model 参数同格式）。用于「勾选 N 个模型生成 N 个成员」与
 * 「给已有成员改模型」。纯受控——目录由 useModelCatalog 注入，本身不发请求。
 */
export function ModelPicker({
  catalog,
  value,
  onChange,
  loading = false,
  error = null,
  disabled = false,
  ariaLabel,
  single = false,
}: ModelPickerProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [enabledOnly, setEnabledOnly] = useState(false);

  const filtered = useMemo(
    () => filterCatalogEntries(catalog.entries, query, enabledOnly),
    [catalog.entries, query, enabledOnly],
  );
  const groups = useMemo(() => groupEntries(filtered), [filtered]);
  const flash = useMemo(() => flashPresetState(filtered, value), [filtered, value]);
  const flashSelectedCount = useMemo(() => {
    const byRef = new Map(catalog.entries.map((entry) => [entry.ref, entry]));
    return value.filter((ref) => {
      const entry = byRef.get(ref);
      return entry ? isFlashModelId(entry.id) : isFlashModelId(ref);
    }).length;
  }, [catalog.entries, value]);

  const toggleFlash = () => {
    if (flash.refs.length === 0) return;
    if (flash.active) {
      const remove = new Set(flash.refs);
      onChange(value.filter((ref) => !remove.has(ref)));
      return;
    }
    onChange([...new Set([...value, ...flash.refs])]);
  };

  return (
    <div
      className={`model-picker${disabled ? " is-disabled" : ""}`}
      role="group"
      aria-label={ariaLabel ?? t("teams.modelPicker.title")}
    >
      <div className="model-picker-toolbar">
        <input
          type="search"
          className="model-picker-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("teams.modelPicker.search")}
          aria-label={t("teams.modelPicker.search")}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
        />
        {catalog.hasEnabledInfo && (
          <button
            type="button"
            className="model-picker-filter"
            aria-pressed={enabledOnly}
            disabled={disabled}
            onClick={() => setEnabledOnly((current) => !current)}
          >
            {t("teams.modelPicker.enabledOnly")}
          </button>
        )}
        {!single && (
          <button
            type="button"
            className="model-picker-flash"
            aria-pressed={flash.active}
            disabled={disabled || flash.refs.length === 0}
            title={flash.refs.length === 0
              ? t("teams.modelPicker.flashNone")
              : t("teams.modelPicker.flashAll")}
            onClick={toggleFlash}
          >
            {t("teams.modelPicker.flashAll")}
          </button>
        )}
        <span
          className="model-picker-count"
          aria-live="polite"
          data-count={value.length}
          data-flash-count={flashSelectedCount}
        >
          {flashSelectedCount > 0
            ? t("teams.modelPicker.selectedFlash", { count: value.length, flash: flashSelectedCount })
            : t("teams.modelPicker.selected", { count: value.length })}
        </span>
        {value.length > 0 && (
          <button
            type="button"
            className="model-picker-clear"
            disabled={disabled}
            onClick={() => onChange([])}
          >
            {t("teams.modelPicker.clear")}
          </button>
        )}
      </div>

      {loading ? (
        <p className="model-picker-hint" data-state="loading">{t("teams.modelPicker.loading")}</p>
      ) : error ? (
        <p className="model-picker-hint model-picker-hint--error" role="alert" data-state="error">{t("teams.modelPicker.error")}</p>
      ) : catalog.entries.length === 0 ? (
        <p className="model-picker-hint" data-state="empty">{t("teams.modelPicker.empty")}</p>
      ) : groups.length === 0 ? (
        <p className="model-picker-hint" data-state="no-match">{t("teams.modelPicker.noMatch")}</p>
      ) : (
        <div className="model-picker-groups">
          {groups.map((group) => (
            <section className="model-picker-group" key={group.provider}>
              <h4 className="model-picker-provider">{group.provider}</h4>
              <ul className="model-picker-models">
                {group.models.map((model) => {
                  const selected = value.includes(model.ref);
                  return (
                    <li key={model.ref}>
                      <button
                        type="button"
                        className={`model-picker-model${selected ? " is-selected" : ""}`}
                        aria-pressed={selected}
                        disabled={disabled}
                        onClick={() => onChange(nextSelection(value, model.ref, single))}
                        title={model.ref}
                      >
                        <span className="model-picker-check" aria-hidden="true" />
                        <span className="model-picker-model-name">{model.name}</span>
                        <span className="model-picker-model-id">{model.id}</span>
                        {!model.enabled && (
                          <span className="model-picker-model-tag">{t("teams.modelPicker.notEnabled")}</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
