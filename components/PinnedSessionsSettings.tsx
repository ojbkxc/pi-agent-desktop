"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AppSelect } from "./AppSelect";
import { ConfigButton } from "./SettingsUi";
import { ConfirmDangerButton } from "./ConfirmDangerButton";

/**
 * Settings › General › Always on —— 常驻会话（pin）与 Router 角色。
 *
 * 自包含：数据全走 `/api/pinned-sessions`，不依赖 SettingsPanel 的 props。
 * **不要** import `lib/pinned-sessions/store.ts`（含 node:fs），类型就地声明。
 *
 * 语义（说清才不会点错）：
 * - 「常驻」= 该会话永远不会因为闲置被卸载（10 分钟 idle 驱逐对它不生效）。
 *   它不会自动跑，只是随时都在。
 * - 角色 `router`（分派者）额外给这个会话注入一段提示：用后台 Agent 派活、别自己动手、
 *   别轮询；结果会自动回到它这里汇总。
 */

interface PinnedEntry {
  sessionId: string;
  role: "router" | "worker";
  note?: string;
  pinnedAt: string;
  registered?: boolean;
}

interface SessionOption {
  id: string;
  title: string;
}

export function PinnedSessionsSettings() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<PinnedEntry[]>([]);
  const [sessions, setSessions] = useState<SessionOption[]>([]);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState("");
  const [pickedRole, setPickedRole] = useState<"router" | "worker">("router");
  /** The add form's own submit. Kept separate so one row's unpin does not put every row into "saving". */
  const [pinning, setPinning] = useState(false);
  const [unpinning, setUnpinning] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [pinnedResponse, sessionsResponse] = await Promise.all([
        fetch("/api/pinned-sessions", { headers: { Accept: "application/json" } }),
        fetch("/api/sessions", { headers: { Accept: "application/json" } }),
      ]);
      if (pinnedResponse.ok) {
        const data = (await pinnedResponse.json()) as { sessions?: PinnedEntry[]; registryError?: string | null };
        setEntries(Array.isArray(data.sessions) ? data.sessions : []);
        setRegistryError(typeof data.registryError === "string" && data.registryError ? data.registryError : null);
      }
      if (sessionsResponse.ok) {
        const data = (await sessionsResponse.json()) as { sessions?: Array<{ id?: string; name?: string; firstMessage?: string }> };
        const list = Array.isArray(data.sessions) ? data.sessions : [];
        setSessions(list
          .filter((session): session is { id: string; name?: string; firstMessage?: string } => typeof session.id === "string")
          .map((session) => ({
            id: session.id,
            title: session.name?.trim() || session.firstMessage?.slice(0, 40) || session.id.slice(0, 12),
          })));
      }
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const pin = async () => {
    if (!pickedId) return;
    setPinning(true);
    try {
      const response = await fetch("/api/pinned-sessions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: pickedId, role: pickedRole }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setPickedId("");
      await load();
    } catch {
      setFailed(true);
    } finally {
      setPinning(false);
    }
  };

  const unpin = async (sessionId: string) => {
    setUnpinning((previous) => new Set(previous).add(sessionId));
    try {
      const response = await fetch(`/api/pinned-sessions?id=${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await load();
    } catch {
      setFailed(true);
    } finally {
      setUnpinning((previous) => {
        const next = new Set(previous);
        next.delete(sessionId);
        return next;
      });
    }
  };

  const roleOptions = [
    { value: "router", label: t("resident.router") },
    { value: "worker", label: t("resident.worker") },
  ];
  const sessionOptions = [
    { value: "", label: t("resident.pickSession") },
    ...sessions.map((session) => ({ value: session.id, label: session.title })),
  ];
  const titleOf = (sessionId: string) =>
    sessions.find((session) => session.id === sessionId)?.title ?? sessionId.slice(0, 12);

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("resident.title")}</h3>
      <p className="settings-general-description">{t("resident.hint")}</p>
      <div className="settings-option-list">
        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("resident.add")}</span>
            <span className="settings-option-hint" role="status">
              {failed ? t("resident.saveFailed") : t("resident.addHint")}
            </span>
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <AppSelect
              aria-label={t("resident.add")}
              value={pickedId}
              onValueChange={setPickedId}
              options={sessionOptions}
              disabled={pinning}
            />
            <AppSelect
              aria-label={t("resident.role")}
              value={pickedRole}
              onValueChange={(next) => setPickedRole(next === "worker" ? "worker" : "router")}
              options={roleOptions}
              disabled={pinning}
            />
            <ConfigButton disabled={pinning || !pickedId} onClick={() => void pin()}>
              {t("resident.pin")}
            </ConfigButton>
          </span>
        </div>

        {registryError && (
          <div className="settings-option">
            <span className="settings-option-text">
              <span className="settings-option-title">{t("resident.registryError")}</span>
              <span className="settings-option-hint" title={registryError}>{registryError}</span>
            </span>
          </div>
        )}

        {entries.length === 0 && (
          <div className="settings-option">
            <span className="settings-option-text">
              <span className="settings-option-hint">{t("resident.empty")}</span>
            </span>
          </div>
        )}

        {entries.map((entry) => (
          <div className="settings-option" key={entry.sessionId}>
            <span className="settings-option-text">
              <span className="settings-option-title">{titleOf(entry.sessionId)}</span>
              <span className="settings-option-hint">
                {t(entry.role === "router" ? "resident.routerHint" : "resident.workerHint")}
                {entry.registered === false ? ` · ${t("resident.notRegistered")}` : ""}
              </span>
              {entry.note && <span className="settings-option-hint">{entry.note}</span>}
            </span>
            <ConfirmDangerButton
              label={t("resident.unpin")}
              confirmLabel={t("settings.confirmUnpin")}
              busyLabel={t("i18n.saving")}
              busy={unpinning.has(entry.sessionId)}
              className="config-button config-button-danger config-button-small"
              onConfirm={() => void unpin(entry.sessionId)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}