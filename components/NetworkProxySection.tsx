"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AppSelect } from "./AppSelect";
import { ConfigButton } from "./SettingsUi";

/**
 * Settings › General › Network proxy —— 会话流量的代理（直连 / 跟随系统 / 手动）。
 *
 * 模型请求由本机 node 服务端发出，而 node 的 fetch 不读系统代理，所以这一项必须显式配。
 * 真源在服务端（`lib/network-proxy.ts`），改完**立即生效**（服务端当场重装 dispatcher）。
 * 这里只用接口，不引 `@/lib/network-proxy` —— 那个模块依赖 node:child_process 与 undici，
 * 不能进客户端 bundle。
 */

type ProxyMode = "direct" | "system" | "manual";

interface ProxyStatus {
  mode: ProxyMode;
  url: string;
  activeProxy: string | null;
  systemProxy: string | null;
  local: boolean;
}

const MODES: ProxyMode[] = ["direct", "system", "manual"];

export function NetworkProxySection() {
  const { t } = useI18n();
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [invalid, setInvalid] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/network-proxy");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as ProxyStatus;
      setStatus(data);
      setUrlDraft(data.url ?? "");
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (mode: ProxyMode, url: string) => {
    setBusy(true);
    setInvalid(false);
    try {
      const response = await fetch("/api/network-proxy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, url }),
      });
      if (response.status === 400 && mode === "manual") {
        setInvalid(true);
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as ProxyStatus;
      setStatus(data);
      setUrlDraft(data.url ?? "");
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const local = status?.local !== false;
  const disabled = busy || !local;

  const statusText = (() => {
    if (!status) return t("settings.networkProxy.loading");
    if (invalid) return t("settings.networkProxy.invalid");
    if (status.activeProxy) return t("settings.networkProxy.active", { proxy: status.activeProxy });
    if (status.mode === "system") return t("settings.networkProxy.systemMissing");
    return t("settings.networkProxy.inactive");
  })();

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("settings.networkProxy")}</h3>
      <p className="settings-general-description">{t("settings.networkProxyHint")}</p>
      <div className="settings-option-list">
        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("settings.networkProxyMode")}</span>
            <span className="settings-option-hint" role="status">
              {failed ? t("settings.networkProxyFailed") : statusText}
            </span>
            {!local && <span className="settings-option-hint">{t("settings.networkProxyRemote")}</span>}
          </span>
          <AppSelect
            aria-label={t("settings.networkProxyMode")}
            value={status?.mode ?? "system"}
            onValueChange={(next) => void save(next as ProxyMode, urlDraft)}
            options={MODES.map((mode) => ({ value: mode, label: t(`settings.networkProxy.${mode}`) }))}
            disabled={disabled || !status}
          />
        </div>

        {status?.mode === "manual" && (
          <label className="remote-access-step">
            <span className="settings-option-hint">{t("settings.networkProxyUrl")}</span>
            <input
              className="mcp-add-input"
              value={urlDraft}
              placeholder="http://127.0.0.1:7890"
              disabled={disabled}
              spellCheck={false}
              onChange={(event) => setUrlDraft(event.target.value)}
            />
            <ConfigButton
              variant="ghost"
              disabled={disabled || urlDraft.trim() === status.url}
              onClick={() => void save("manual", urlDraft)}
            >
              {t("settings.networkProxySave")}
            </ConfigButton>
          </label>
        )}

        {status?.mode === "system" && status.systemProxy && (
          <span className="settings-option-hint">
            {t("settings.networkProxy.systemDetected", { proxy: status.systemProxy })}
          </span>
        )}
      </div>
    </section>
  );
}
