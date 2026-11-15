"use client";

import { useAutofix, summarizeAutofixState } from "@/hooks/useAutofix";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  active: boolean;
  onOpen: () => void;
}

/** The Auto-fix entry under New Session: opens the task list, badges active fixes. */
export function AutofixSidebarRow({ active, onOpen }: Props) {
  const { t } = useI18n();
  const state = useAutofix();
  const { active: activeCount, stuck } = summarizeAutofixState(state);

  return (
    <button
      type="button"
      className={`sidebar-header-row sidebar-scheduled-row${active ? " is-active" : ""}`}
      onClick={onOpen}
      aria-current={active ? "page" : undefined}
      title={t("sidebar.autofix")}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m8 6 4-4 4 4" />
        <path d="M12 2v10.3a4 4 0 1 0 4 3.7" />
        <path d="m2 6 4 4-4 4" opacity="0" />
      </svg>
      <span className="sidebar-scheduled-label">{t("sidebar.autofix")}</span>
      {activeCount > 0 && (
        <span className="sidebar-scheduled-badge" aria-label={t("sidebar.autofixActive", { count: activeCount })}>
          {activeCount > 99 ? "99+" : activeCount}
        </span>
      )}
      {activeCount === 0 && stuck > 0 && (
        <span className="sidebar-scheduled-dot sidebar-scheduled-dot--attention" aria-hidden="true" />
      )}
    </button>
  );
}
