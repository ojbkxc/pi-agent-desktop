"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { MarkdownBody } from "@/components/MarkdownBody";
import {
  formatBytes,
  formatDownloads,
  formatIsoDate,
  securityBadgeClass,
  sortMarketFiles,
  type MarketFileMeta,
  type MarketListItem,
  type MarketSecurityReport,
  type MarketSkillDetail,
} from "./market-helpers";
import { detectCapabilities, type Capability } from "./skill-insights";

/**
 * 市场详情 + 安装确认。
 *
 * 页签（概览 / 文件 / 安全报告，更新日志有才出现）都是从 `/api/market/skills/[id]`
 * 一份详情里切的；文件页签点某个文件才按需拉 `/api/market/skills/[id]/file`，
 * 不把整包推给浏览器。
 *
 * 安装前一定先给确认面板：它会写明来源、作者、版本、大小与安全结论。安装本身只 POST
 * `{ id, owner }`，落盘位置由服务端按 slug 生成。
 */

type Tab = "overview" | "files" | "security" | "changelog";

/** 详情页签顺序：更新日志页签只在有 changelog 时追加到末尾（只能说出「这里什么都没有」的页签不值得占位）。 */
export function detailTabKeys(hasChangelog: boolean): Tab[] {
  return hasChangelog ? ["overview", "files", "security", "changelog"] : ["overview", "files", "security"];
}

export interface MarketSecurityTabProps {
  /** 精选技能带风险结论时编辑给出的说明；有就展示「精选说明」区块。 */
  securityNote?: string;
  /** 上游扫描报告（来源方提供时才有）。 */
  reports?: MarketSecurityReport[];
}

/**
 * 详情「安全报告」页签的正文（从 SkillMarketDetail 抽出以便单测）。
 *
 * 精选技能的 `securityNote` 必须在这条路径上渲染：catalog 详情命中快照时，服务端会回填
 * `securityStatus` / `securityNote` 等字段（见 O1），所以浏览路径必须消费它，否则「精选说明」
 * 区块就永远不可达。注意这里**只**读 `securityNote`，不吃 `securityReports` 之外的字段。
 */
export function MarketSecurityTab({ securityNote, reports }: MarketSecurityTabProps) {
  const { t } = useI18n();
  return (
    <div className="market-detail-body">
      {securityNote && (
        <div className="market-security-note" data-testid="market-security-note">
          <p className="market-section-title">{t("market.detail.securityNote")}</p>
          <p className="scheduled-hint">{securityNote}</p>
        </div>
      )}
      {reports && reports.length > 0 ? (
        <ul className="market-security-list">
          {reports.map((report) => (
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
  );
}

/**
 * 能力面板（概览页签顶部）：「安装前请了解：这个技能会做什么」。
 *
 * 每条能力都列出证据来源（文件名 / 命令 / 变量 / 主机名），读者可以自己去核对，
 * 而不必相信这句结论。没有规则命中时整块不渲染——一块空的「这里没有风险」面板
 * 是这些规则给不出的结论。
 */
export function CapabilityPanel({
  capabilities,
  onViewReport,
}: {
  capabilities: readonly Capability[];
  /** 表头链接；省略时不渲染（面板已嵌在报告里时用）。 */
  onViewReport?: () => void;
}) {
  const { t } = useI18n();
  if (capabilities.length === 0) return null;
  return (
    <section className="market-cap" aria-labelledby="market-cap-title" data-testid="market-capability-panel">
      <header className="market-cap-head">
        <span className="market-cap-icon" aria-hidden="true">⚠</span>
        <h3 id="market-cap-title" className="market-cap-title">{t("market.cap.title")}</h3>
        {onViewReport && (
          <button type="button" className="market-cap-report" data-testid="market-capability-view-report" onClick={onViewReport}>
            {t("market.cap.viewReport")}
          </button>
        )}
      </header>
      <ul className="market-cap-list">
        {capabilities.map((capability) => {
          // shell 用斜杠连命令（更像命令行），其余用顿号连路径/变量（更像列表）。
          const evidence = capability.evidence.join(capability.kind === "shell" ? " / " : "、");
          return (
            <li key={capability.kind} className="market-cap-row" data-testid={`market-capability-${capability.kind}`}>
              <span className="market-cap-text">
                <span className="market-cap-kind">{t(`market.cap.${capability.kind}`)}</span>
                <span className="market-cap-detail">{t(`market.cap.${capability.kind}.detail`, { evidence })}</span>
              </span>
              <span className={`market-cap-level is-${capability.level}`}>{t(`market.cap.level.${capability.level}`)}</span>
            </li>
          );
        })}
      </ul>
      <p className="market-cap-note">{t("market.cap.note")}</p>
    </section>
  );
}

/**
 * 详情「更新日志」页签的正文（从 SkillMarketDetail 抽出以便单测）。
 * changelog 不存在时页签本身不会出现（见调用处），这里的兜底文案覆盖边界情形。
 */
export function MarketChangelogTab({
  changelog,
  version,
}: {
  changelog?: MarketSkillDetail["changelog"];
  /** 上游更新说明没写版本号时，用技能当前版本兜底。 */
  version?: string;
}) {
  const { t } = useI18n();
  if (!changelog) {
    return (
      <div className="market-detail-body">
        <p className="scheduled-hint">{t("market.detail.noChangelog")}</p>
      </div>
    );
  }
  const releaseVersion = changelog.version || version;
  const published = formatIsoDate(changelog.publishedAt);
  return (
    <div className="market-detail-body" data-testid="market-changelog-tab">
      <div className="market-changelog-head">
        {releaseVersion && (
          <span className="market-badge is-unknown">
            {releaseVersion.startsWith("v") ? releaseVersion : `v${releaseVersion}`}
          </span>
        )}
        {published && <span className="market-changelog-date">{published}</span>}
      </div>
      <p className="market-changelog-text">{changelog.text}</p>
    </div>
  );
}

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

  // 能力识别吃的是这份详情自己的 SKILL.md 正文 + frontmatter + 文件清单，纯函数、无副作用。
  const capabilities = useMemo<Capability[]>(() => {
    const current = detail?.skill;
    if (!current) return [];
    return detectCapabilities({
      markdown: current.description,
      frontmatter: current.descriptionFrontmatter,
      files: current.files,
    });
  }, [detail?.skill]);

  if (!selectedId) return null;

  const skill = detail?.status === "ready" ? detail.skill : undefined;
  const installed = skill?.installState === "installed";
  const installedPath = skill?.installedInfo?.dirName;

  // 更新日志页签只在有 changelog 时出现：只能说出「这里什么都没有」的页签不值得占一个位置。
  const detailTabs: Tab[] = detailTabKeys(Boolean(skill?.changelog));

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
            {detailTabs.map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className={`market-tab${tab === value ? " is-active" : ""}`}
                onClick={() => setTab(value)}
              >
                {value === "changelog"
                  ? t("market.changelog")
                  : t(`market.tab.${value}`, value === "files" ? { count: files.length } : undefined)}
              </button>
            ))}
          </div>

          {tab === "overview" && (
            <div className="market-detail-body">
              <CapabilityPanel capabilities={capabilities} onViewReport={() => setTab("security")} />
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
            <MarketSecurityTab securityNote={skill.securityNote} reports={skill.securityReports} />
          )}

          {tab === "changelog" && (
            <MarketChangelogTab changelog={skill.changelog} version={skill.version} />
          )}
        </>
      )}
    </aside>
  );
}