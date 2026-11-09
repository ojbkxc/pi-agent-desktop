"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import { AppSelect } from "./AppSelect";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";

interface PublicAccessView {
  state: "unconfigured" | "disabled" | "connecting" | "online" | "reconnecting" | "failed";
  phase: "preparing" | "connecting" | "routing" | "checking" | null;
  error: "network" | "configuration" | "token" | "route" | "runtime" | "stop" | null;
  publicUrl: string | null;
  mode: "quick" | "named";
  localPort: number;
  customUrl: string;
  tokenSet: boolean;
  tunnelId: string | null;
  autoStart: boolean;
  enabled: boolean;
}

interface PublicAccessResponse {
  view: PublicAccessView;
  binary: { available: boolean; source: string | null };
  passwordSet: boolean;
  local: boolean;
}

interface ServerSettingsResponse {
  port: number | null;
  configured: number | null;
  local: boolean;
}

const LIVE_STATES = new Set(["connecting", "reconnecting", "online"]);
const POLL_MS = 2000;

const MODES = ["quick", "named"] as const;

/**
 * Settings › General › Server: the listener port and the Cloudflare tunnel
 * (see lib/public-access/*). The tunnel points at this server's own port, so the
 * only thing the user picks is how Cloudflare publishes it and where.
 */
export function ServerSection() {
  const { t } = useI18n();
  const [server, setServer] = useState<ServerSettingsResponse | null>(null);
  const [publicAccess, setPublicAccess] = useState<PublicAccessResponse | null>(null);
  const [portDraft, setPortDraft] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [customUrlDraft, setCustomUrlDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // 「下载 cloudflared」自己的状态：它是一次可能长达十几分钟的子进程下载，**不能**借用
  // 全局 busy —— 那会把端口/模式/Token/Save 一起锁死，用户会以为整个设置页坏了（打包版
  // 实际就是这个观感）。失败文案走本地化固定文案，原始 stderr 只进 title。
  const [installing, setInstalling] = useState(false);
  const [installDetail, setInstallDetail] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // d5-1：start/stop 的 POST 只更新视图、从不续排轮询链——从非 live 态启动隧道时
  // 状态会永远停在 connecting。POST 成功后踢一次轮询 effect 重新探测。
  const [publicAccessPollKick, setPublicAccessPollKick] = useState(0);
  const initialized = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/server-settings", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((next: ServerSettingsResponse) => {
        if (cancelled) return;
        setServer(next);
        setPortDraft(String(next.configured ?? next.port ?? ""));
      })
      .catch(() => { if (!cancelled) setError(t("server.loadFailed")); });
    return () => { cancelled = true; };
  }, [t]);

  // Poll while the tunnel is doing something (starting, retrying, or up) so the
  // status line reflects state changes without a manual refresh.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastLive = false;
    const load = async () => {
      try {
        const response = await fetch("/api/public-access", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = await response.json() as PublicAccessResponse;
        if (cancelled) return;
        setPublicAccess(next);
        if (!initialized.current) {
          initialized.current = true;
          setCustomUrlDraft(next.view.customUrl);
        }
        lastLive = LIVE_STATES.has(next.view.state);
        if (lastLive) {
          timer = setTimeout(() => {
            timer = undefined;
            // A background tab skips the tick (and with it the chain's only
            // continuation); onVisibility resumes the poll on the way back.
            if (document.visibilityState === "visible") void load();
          }, POLL_MS);
        }
      } catch {
        if (!cancelled) setError(t("server.loadFailed"));
      }
    };
    const onVisibility = () => {
      // The setTimeout chain dies while hidden: resume it when the tab returns
      // and the tunnel is (as far as we know) still live.
      if (document.visibilityState === "visible" && !cancelled && lastLive && !timer) void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // reloadKey re-runs the probe after a download, since `binary.available` is
    // resolved per request and would otherwise stay stale until the panel reopens.
    // publicAccessPollKick (d5-1) re-runs it after a start/stop POST for the same reason.
  }, [t, reloadKey, publicAccessPollKick]);

  const call = useCallback(async (
    input: RequestInfo,
    init: RequestInit,
    key: "server-settings" | "public-access",
  ) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const response = await fetch(input, init);
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
      if (key === "server-settings") setServer(body as unknown as ServerSettingsResponse);
      else {
        setPublicAccess((previous) => (previous ? { ...previous, view: body.view as PublicAccessView } : previous));
        // d5-1：踢一次轮询。effect 重跑后的首次 GET 会按返回状态重算 lastLive：
        // connecting/reconnecting/online 自续 2s 链，终态（disabled/failed 等）自然停。
        setPublicAccessPollKick((kick) => kick + 1);
      }
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  // 「下载 cloudflared」不走 call()：它自己的 installing 状态不锁其余控件，失败按
  // 固定本地化文案提示（route 回 {error, code, detail}，detail 只进 title）。
  const installBinary = useCallback(async () => {
    setInstalling(true);
    setError(null);
    setNote(null);
    setInstallDetail(null);
    try {
      const response = await fetch("/api/public-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "install-binary" }),
      });
      const body = await response.json().catch(() => ({})) as { detail?: unknown };
      if (!response.ok) {
        setInstallDetail(typeof body.detail === "string" ? body.detail : `HTTP ${response.status}`);
        setError(t("publicAccess.binaryDownloadFailed"));
        return;
      }
      setNote(t("publicAccess.binaryReady"));
      setReloadKey((value) => value + 1);
    } catch (caught) {
      setInstallDetail(caught instanceof Error ? caught.message : String(caught));
      setError(t("publicAccess.binaryDownloadFailed"));
    } finally {
      setInstalling(false);
    }
  }, [t]);

  const view = publicAccess?.view;
  const json = (body: unknown): RequestInit => ({
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const action = (body: unknown) => call("/api/public-access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, "public-access");

  const portValue = Number(portDraft);
  const portValid = Number.isInteger(portValue) && portValue >= 1024 && portValue <= 65535;
  // `server.port` is what this process actually listens on; a different saved value
  // takes effect only after a restart, which is what the notice says.
  const portStatus = !portValid
    ? t("server.portInvalid")
    : server?.port == null
      ? t("server.portHint")
      : portValue !== server.port
        ? t("server.restartNotice", { port: portDraft, running: server.port })
        : t("server.portRunning", { port: server.port });

  const statusText = (() => {
    if (!view) return t("server.loading");
    if (view.phase) return t(`publicAccess.phase.${view.phase}`);
    if (view.error) return `${t(`publicAccess.state.${view.state}`)} · ${t(`publicAccess.error.${view.error}`)}`;
    return t(`publicAccess.state.${view.state}`);
  })();

  return (
    <section className="settings-general-section server-section">
      <h3 className="settings-general-heading">{t("server.title")}</h3>
      <p className="settings-general-description">{t("server.description")}</p>
      <div className="settings-option-list">
        <label className="remote-access-step">
          <span className="settings-option-hint">{t("server.portHint")}</span>
          <input
            className="mcp-add-input"
            inputMode="numeric"
            value={portDraft}
            disabled={!server?.local || busy}
            spellCheck={false}
            onChange={(event) => setPortDraft(event.target.value.replace(/[^\d]/g, ""))}
          />
        </label>
        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("server.portLabel")}</span>
            <span className="settings-option-hint" role="status">{portStatus}</span>
          </span>
          <ConfigButton
            className="settings-option-action"
            variant="ghost"
            disabled={!server?.local || busy || !portValid || Number(portDraft) === server?.configured}
            onClick={() => void call("/api/server-settings", json({ serverPort: portValue }), "server-settings")
              .then((ok) => { if (ok) setNote(t("server.portSaved")); })}
          >
            {t("server.save")}
          </ConfigButton>
        </div>

        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("publicAccess.title")}</span>
            <span className="settings-option-hint" role="status">{statusText}</span>
          </span>
          {view?.publicUrl && (
            <ConfigButton
              className="settings-option-action"
              variant="ghost"
              onClick={() => {
                void copyText(view.publicUrl!).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? t("publicAccess.copied") : t("publicAccess.copy")}
            </ConfigButton>
          )}
        </div>

        {publicAccess && !publicAccess.passwordSet && (
          <span className="settings-option-hint" role="alert">{t("publicAccess.passwordRequired")}</span>
        )}
        {publicAccess && !publicAccess.binary.available && (
          <div className="settings-option">
            <span className="settings-option-text">
              <span className="settings-option-title">{t("publicAccess.binary")}</span>
              <span className="settings-option-hint" role="status">
                {installing ? t("publicAccess.downloading") : t("publicAccess.binaryMissing")}
              </span>
            </span>
            <ConfigButton
              className="settings-option-action"
              variant="ghost"
              disabled={!publicAccess.local || installing}
              onClick={() => void installBinary()}
            >
              {installing ? t("publicAccess.downloading") : t("publicAccess.download")}
            </ConfigButton>
          </div>
        )}

        {view && (
          <>
            <div className="settings-option">
              <span className="settings-option-text">
                <span className="settings-option-title">{t("publicAccess.mode")}</span>
                <span className="settings-option-hint">{view.mode === "quick" ? t("publicAccess.quickHint") : t("publicAccess.namedHint")}</span>
              </span>
              <AppSelect
                aria-label={t("publicAccess.mode")}
                value={view.mode}
                onValueChange={(next) => void call("/api/public-access", json({
                  enabled: view.enabled,
                  mode: next,
                  customUrl: next === "named" ? customUrlDraft.trim() : "",
                  ...(tokenDraft.trim() ? { token: tokenDraft.trim() } : {}),
                }), "public-access").then((ok) => { if (ok) setTokenDraft(""); })}
                options={MODES.map((mode) => ({ value: mode, label: t(`publicAccess.${mode}`) }))}
                disabled={busy || !publicAccess?.local}
              />
            </div>

            {view.mode === "named" && (
              <>
                <label className="remote-access-step">
                  <span className="settings-option-hint">{t("publicAccess.token")}</span>
                  <input
                    className="mcp-add-input"
                    type="password"
                    value={tokenDraft}
                    placeholder={view.tokenSet ? t("publicAccess.tokenSaved") : ""}
                    disabled={busy || !publicAccess?.local}
                    spellCheck={false}
                    autoComplete="new-password"
                    onChange={(event) => setTokenDraft(event.target.value)}
                  />
                  <span className="settings-option-hint">
                    {view.tunnelId ? t("publicAccess.tokenFound", { id: view.tunnelId }) : t("publicAccess.tokenHint")}
                  </span>
                </label>
                <label className="remote-access-step">
                  <span className="settings-option-hint">{t("publicAccess.customUrl")}</span>
                  <input
                    className="mcp-add-input"
                    value={customUrlDraft}
                    placeholder="https://pi.example.com"
                    disabled={busy || !publicAccess?.local}
                    spellCheck={false}
                    onChange={(event) => setCustomUrlDraft(event.target.value)}
                  />
                  <span className="settings-option-hint">{t("publicAccess.customUrlHint")}</span>
                </label>
                <ConfigButton
                  variant="ghost"
                  disabled={busy || !publicAccess?.local}
                  onClick={() => void call("/api/public-access", json({
                    enabled: view.enabled,
                    mode: "named",
                    customUrl: customUrlDraft.trim(),
                    ...(tokenDraft.trim() ? { token: tokenDraft.trim() } : {}),
                  }), "public-access").then((ok) => { if (ok) setTokenDraft(""); })}
                >
                  {t("publicAccess.saveConfiguration")}
                </ConfigButton>
              </>
            )}

            <div className="settings-option">
              <span className="settings-option-text">
                <span className="settings-option-title">{t("publicAccess.switch")}</span>
                <span className="settings-option-hint" role="status">
                  {note ?? (!publicAccess?.local ? t("publicAccess.localOnly") : t("publicAccess.switchHint"))}
                </span>
              </span>
              <ConfigSwitch
                checked={view.state === "online" || view.state === "connecting" || view.state === "reconnecting"}
                loading={busy || view.state === "connecting"}
                disabled={!publicAccess?.local || !publicAccess.passwordSet || !publicAccess.binary.available}
                label={t("publicAccess.switch")}
                onChange={(next) => void action({ action: next ? "start" : "stop" })}
              />
            </div>

            <div className="settings-option">
              <span className="settings-option-text">
                <span className="settings-option-title">{t("publicAccess.autoStart")}</span>
                <span className="settings-option-hint">{t("publicAccess.autoStartHint")}</span>
              </span>
              <ConfigSwitch
                checked={view.autoStart}
                disabled={!publicAccess?.local || busy}
                label={t("publicAccess.autoStart")}
                onChange={(next) => void action({ action: "auto-start", enabled: next })}
              />
            </div>
          </>
        )}
        {error && (
          <span className="settings-option-hint" role="alert" title={installDetail ?? undefined}>
            {error}
          </span>
        )}
      </div>
    </section>
  );
}
