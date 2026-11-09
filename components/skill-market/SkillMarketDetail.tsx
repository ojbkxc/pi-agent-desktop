"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { MarkdownBody } from "@/components/MarkdownBody";
import {
  formatBytes,
  formatDownloads,
  securityBadgeClass,
  sortMarketFiles,
  type MarketFileMeta,
  type MarketListItem,
  type MarketSkillDetail,
} from "./market-helpers";

/**
 * 市场详情 + 安装确认。
 *
 * 三个页签（概览 / 文件 / 安全报告）都是从 `/api/market/skills/[id]` 一份详情里切的；
 * 文件页签点某个文件才按需拉 `/api/market/skills/[id]/file`，不把整包推给浏览器。
 *
 * 安装前一定先给确认面板：它会写明来源、作者、版本、大小与安全结论。安装本身只 POST
 * `{ id, owner }`，落盘位置由服务端按 slug 生成。
 */

type Tab = "overview" | "files" | "security";

interface Props {
  selectedId: string | null;
  /** 「已安装」页签里那一行（没有详情接口的上下文时兜底展示）。 */
  installedFallback: MarketListItem | null;
  onClose: () => void;
  onInstalled: () => void;
  onRevealInstalled?: (path: string) => void;
}

interface DetailState {
  id: string;
  status: "loading" | "ready" | "error";
  skill?: MarketSkillDetail;
  error?: string;
}

interface FileState {
  path: string;
  status: "loading" | "ready" | "error";
  content?: string;
  truncated?: boolean;
  error?: string;
}

export function SkillMarketDetail({
  selectedId,
  installedFallback,
  onClose,
  onInstalled,
  onRevealInstalled,
}: Props) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [file, setFile] = useState<FileState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  // 代际守卫：快速点两张卡时，先发的详情后落地不能盖掉后选的。
  const seqRef = useRef(0);

  const load = useCallback(async (id: string) => {
    const generation = ++seqRef.current;
    setDetail({ id, status: "loading" });
    setFile(null);
    setTab("overview");
    setActionError(null);
    setActionMessage(null);
    setConfirming(false);
    try {
      const response = await fetch(`/api/market/skills/${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await response.json() as { skill?: MarketSkillDetail; error?: string };
      if (generation !== seqRef.current) return;
      if (!response.ok || !data.skill) throw new Error(data.error ?? `HTTP ${response.status}`);
      setDetail({ id, status: "ready", skill: data.skill });
    } catch (err) {
      if (generation === seqRef.current) {
        setDetail({ id, status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setFile(null);
      setConfirming(false);
      return;
    }
    void load(selectedId);
  }, [selectedId, load]);

  const openFile = useCallback(async (path: string) => {
    if (!selectedId) return;
    const generation = seqRef.current;
    setFile({ path, status: "loading" });
    try {
      const params = new URLSearchParams({ path });
      const owner = detail?.skill?.owner;
      if (owner) params.set("owner", owner);
      const response = await fetch(
        `/api/market/skills/${encodeURIComponent(selectedId)}/file?${params}`,
        { cache: "no-store" },
      );
      const data = await response.json() as { content?: string; truncated?: boolean; error?: string };
      if (generation !== seqRef.current) return;
      if (!response.ok || typeof data.content !== "string") throw new Error(data.error ?? `HTTP ${response.status}`);
      setFile({ path, status: "ready", content: data.content, truncated: data.truncated });
    } catch (err) {
      if (generation === seqRef.current) {
        setFile({ path, status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    }
  }, [detail?.skill?.owner, selectedId]);

  const runInstall = useCallback(async () => {
    const skill = detail?.skill;
    if (!skill) return;
    setBusy(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const response = await fetch("/api/market/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: skill.id,
          ...(skill.owner ? { owner: skill.owner } : {}),
        }),
      });
      const data = await response.json() as { ok?: boolean; installedPath?: string; error?: string; code?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setConfirming(false);
      setActionMessage(t("market.installSuccess", { name: skill.name }));
      setDetail((current) => current?.skill
        ? { ...current, skill: { ...current.skill, installState: "installed" } }
        : current);
      onInstalled();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [detail?.skill, onInstalled, t]);

  const runUninstall = useCallback(async () => {
    const skill = detail?.skill;
    if (!skill) return;
    setBusy(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const response = await fetch("/api/market/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: skill.id, action: "uninstall" }),
      });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setActionMessage(t("market.uninstallSuccess", { name: skill.name }));
      setDetail((current) => current?.skill
        ? { ...current, skill: { ...current.skill, installState: "installable" } }
        : current);
      onInstalled();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [detail?.skill, onInstalled, t]);

  const files = useMemo(() => sortMarketFiles(detail?.skill?.files ?? []), [detail?.skill?.files]);

  if (!selectedId) return null;

  const skill = detail?.status === "ready" ? detail.skill : undefined;
  const installed = skill?.installState === "installed";
  const installedPath = skill?.installedInfo?.dirName;

  return (
    <aside className="market-detail" aria-label={t("market.detailLabel")}>
      {detail?.status === "loading" && (
        <p className="scheduled-hint" role="status">{t("market.loadingDetail")}</p>
      )}

      {detail?.status === "error" && (
        <>
          <p className="scheduled-error" role="alert">{detail.error}</p>
          {installedFallback && (
            <p className="scheduled-hint">{t("market.installedFallback", { name: installedFallback.name })}</p>
          )}
        </>
      )}

      {skill && (
        <>
          <div className="market-detail-head">
            <div className="market-detail-title">
              <h2>{skill.name}</h2>
              <p className="scheduled-hint market-detail-source">
                {skill.author?.handle ? `${skill.author.handle} · ` : ""}
                {t(`market.source.${skill.source}`)}
                {skill.version ? ` · v${skill.version}` : ""}
              </p>
            </div>
            <button type="button" className="scheduled-back market-detail-close" onClick={onClose}>
              {t("market.close")}
            </button>
          </div>

          <div className="market-detail-badges">
            <span className={`market-badge ${securityBadgeClass(skill.securityStatus)}`}>
              {t(`market.security.${skill.securityStatus ?? "unknown"}`)}
            </span>
            {installed && <span className="market-badge is-safe">{t("market.installed")}</span>}
            <span className="market-card-downloads">
              {t("market.downloads", { count: formatDownloads(skill.stats?.downloads ?? 0) })}
            </span>
            {skill.pageUrl && (
              <a className="market-detail-link" href={skill.pageUrl} target="_blank" rel="noopener noreferrer">
                {t("market.openSource")}
              </a>
            )}
          </div>

          <div className="market-detail-actions">
            {installed ? (
              <>
                <button type="button" className="scheduled-button" onClick={() => void runUninstall()} disabled={busy}>
                  {busy ? t("market.uninstalling") : t("market.uninstall")}
                </button>
                {installedPath && onRevealInstalled && (
                  <button
                    type="button"
                    className="scheduled-button is-secondary"
                    onClick={() => onRevealInstalled(skill.installedInfo?.dirName ?? "")}
                  >
                    {t("market.revealInstalled")}
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                className="scheduled-button"
                onClick={() => setConfirming(true)}
                disabled={busy || skill.installState === "not-installable"}
              >
                {t("market.install")}
              </button>
            )}
        </div>

          {actionMessage && <p className="scheduled-notice" role="status">{actionMessage}</p>}
          {actionError && <p className="scheduled-error" role="alert">{actionError}</p>}

          {confirming && !installed && (
            <div className="market-confirm" role="alertdialog" aria-label={t("market.confirmTitle")}>
              <p className="market-confirm-title">{t("market.confirmTitle")}</p>
              <p className="scheduled-hint">{t("market.confirmBody", { source: skill.pageUrl || skill.name })}</p>
              <dl className="market-confirm-facts">
                <div><dt>{t("market.fact.source")}</dt><dd>{t(`market.source.${skill.source}`)}</dd></div>
                <div><dt>{t("market.fact.author")}</dt><dd>{skill.author?.handle || "—"}</dd></div>
                <div><dt>{t("market.fact.version")}</dt><dd>{skill.version || "—"}</dd></div>
                <div><dt>{t("market.fact.size")}</dt><dd>{formatBytes(skill.totalSize)}</dd></div>
                <div><dt>{t("market.fact.files")}</dt><dd>{skill.files.length}</dd></div>
                <div><dt>{t("market.fact.security")}</dt><dd>{t(`market.security.${skill.securityStatus ?? "unknown"}`)}</dd></div>
              </dl>
              <div className="market-confirm-actions">
                <button type="button" className="scheduled-button is-secondary" onClick={() => setConfirming(false)} disabled={busy}>
                  {t("market.cancel")}
                </button>
                <button type="button" className="scheduled-button" onClick={() => void runInstall()} disabled={busy}>
                  {busy ? t("market.installing") : t("market.confirmInstall")}
                </button>
              </div>
            </div>
          )}

          <div className="market-tabs market-detail-tabs" role="tablist" aria-label={t("market.detailTabsLabel")}>
            {(["overview", "files", "security"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className={`market-tab${tab === value ? " is-active" : ""}`}
                onClick={() => setTab(value)}
              >
                {t(`market.tab.${value}`, value === "files" ? { count: files.length } : undefined)}
              </button>
            ))}
          </div>

          {tab === "overview" && (
            <div className="market-detail-body">
              {skill.descriptionFrontmatter && Object.keys(skill.descriptionFrontmatter).length > 0 && (
                <div className="market-frontmatter">
                  <p className="market-section-title">{t("market.frontmatter")}</p>
                  <pre>{JSON.stringify(skill.descriptionFrontmatter, null, 2)}</pre>
                </div>
              )}
              {skill.description.trim() ? (
                <div className="market-markdown">
                  <MarkdownBody>{skill.description}</MarkdownBody>
                </div>
              ) : (
                <p className="scheduled-hint">{t("market.noDescription")}</p>
              )}
              {skill.changelog && (
                <div className="market-frontmatter">
                  <p className="market-section-title">{t("market.changelog")}</p>
                  <p className="scheduled-hint">{skill.changelog.text}</p>
                </div>
              )}
            </div>
          )}

          {tab === "files" && (
            <div className="market-detail-body">
              {files.length === 0 ? (
                <p className="scheduled-hint">{t("market.noFiles")}</p>
              ) : (
                <>
                  <ul className="market-file-list">
                    {files.map((meta: MarketFileMeta) => (
                      <li key={meta.path}>
                        <button
                          type="button"
                          className={`market-file-row${file?.path === meta.path ? " is-active" : ""}`}
                          onClick={() => void openFile(meta.path)}
                          disabled={meta.tooBig}
                          title={meta.tooBig ? t("market.fileTooBig") : meta.path}
                        >
                          <span className="market-file-path">{meta.path}</span>
                          <span className="market-file-size">{formatBytes(meta.size)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {file?.status === "loading" && <p className="scheduled-hint">{t("market.loadingFile")}</p>}
                  {file?.status === "error" && <p className="scheduled-error" role="alert">{file.error}</p>}
                  {file?.status === "ready" && (
                    <div className="market-file-preview">
                      {file.truncated && <p className="scheduled-hint">{t("market.fileTruncated")}</p>}
                      {file.path.endsWith(".md")
                        ? <div className="market-markdown"><MarkdownBody>{file.content ?? ""}</MarkdownBody></div>
                        : <pre className="market-file-code">{file.content}</pre>}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {tab === "security" && (
            <div className="market-detail-body">
              {skill.securityReports && skill.securityReports.length > 0 ? (
                <ul className="market-security-list">
                  {skill.securityReports.map((report) => (
                    <li key={`${report.vendor}-${report.status}`}>
                      <span className={`market-badge ${securityBadgeClass(report.status)}`}>{report.vendor}</span>
                      <span className="market-security-text">{report.statusText}</span>
                      {report.summary && <p className="scheduled-hint">{report.summary}</p>}
                      {report.reportUrl && (
                        <a className="market-detail-link" href={report.reportUrl} target="_blank" rel="noopener noreferrer">
                          {t("market.openReport")}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="scheduled-hint">{t("market.noSecurityReports")}</p>
              )}
            </div>
          )}
        </>
      )}
    </aside>
  );
}