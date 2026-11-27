"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { appNotify } from "@/lib/notification-store";
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

/** 手动模式保存请求的最长等待时间（毫秒）。 */
const SAVE_TIMEOUT_MS = 30_000;

/** 客户端预校验：手动模式的 URL 必须是 http:// 或 https:// 开头。 */
function isValidProxyUrl(url: string): boolean {
  const trimmed = url.trim();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://");
}

/** 从错误响应 body 中提取服务端返回的 error 字段。 */
async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" && body.error.trim() ? body.error.trim() : null;
  } catch {
    return null;
  }
}

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
    // 客户端预校验：手动模式必须填合法的 http/https 代理地址。
    if (mode === "manual" && !isValidProxyUrl(url)) {
      setInvalid(true);
      appNotify.error({ message: t("settings.networkProxy.invalid") });
      return;
    }

    setBusy(true);
    setInvalid(false);

    // 30 秒超时：防止弱网环境下请求挂死导致界面无反馈。
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SAVE_TIMEOUT_MS);

    try {
      const response = await fetch("/api/network-proxy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, url }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        // 优先展示服务端返回的具体错误（如 "URL 必须是 http:// 开头"）。
        const serverError = await readErrorMessage(response);
        if (response.status === 400) {
          setInvalid(true);
          appNotify.error({
            message: serverError ?? t("settings.networkProxy.invalid"),
          });
        } else {
          setFailed(true);
          appNotify.error({
            message: serverError ?? t("settings.networkProxyFailed"),
          });
        }
        return;
      }

      const data = (await response.json()) as ProxyStatus;
      setStatus(data);
      setUrlDraft(data.url ?? "");
      setFailed(false);
      // 保存成功：给出明确反馈，避免用户不确定是否生效。
      appNotify.success({ message: t("settings.networkProxy.saved") });
    } catch (error) {
      clearTimeout(timeoutId);
      setFailed(true);
      // 区分超时和普通网络错误，给出更准确的提示。
      if (error instanceof Error && error.name === "AbortError") {
        appNotify.error({ message: t("settings.networkProxy.timeout") });
      } else {
        appNotify.error({ message: t("settings.networkProxyFailed") });
      }
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
