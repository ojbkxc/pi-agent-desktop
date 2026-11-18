"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { openExternal } from "@/lib/desktop-native";
import { formatRelativeTime } from "@/lib/i18n/format";
import { AppSelect } from "./AppSelect";
import { ChatConfirmDialog } from "./ChatConfirmDialog";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";

/** 服务端诊断事件（lib/public-access/diagnostics.ts 的契约；字段都可选地缺席）。 */
interface PublicAccessDiagnosticEntry {
  stage: string;
  outcome: "started" | "succeeded" | "failed" | "cancelled" | "retrying";
  durationMs?: number;
  reason?: string;
  error?: unknown;
  details?: Record<string, unknown>;
}

interface PublicAccessView {
  state: "unconfigured" | "disabled" | "connecting" | "online" | "reconnecting" | "failed";
  phase: "preparing" | "connecting" | "routing" | "checking" | null;
  /** `proxy` 来自代理桥（server 侧新增；老版本不会返回它）。 */
  error: "network" | "configuration" | "token" | "route" | "runtime" | "stop" | "proxy" | null;
  publicUrl: string | null;
  /** 命名隧道 + 自定义域名的固定域名绑定判定；quick / 未填域名恒为 null。 */
  domainBinding: { state: "polling" | "bound" | "unbound" | "timeout"; reason: "other-hostnames" | "service-mismatch" | null } | null;
  /** 本次 online 是否由服务器启动时的自动恢复建立。 */
  restoredByAutoStart: boolean;
  mode: "quick" | "named";
  /**
   * 运行期真实监听端口（manager 恒取 process.env.PORT），不是配置里记的值。
   * 界面上按「当前实际端口」展示，避免用户以为要自己算。
   */
  localPort: number;
  customUrl: string;
  tokenSet: boolean;
  tunnelId: string | null;
  autoStart: boolean;
  enabled: boolean;
  /**
   * 服务端最近一次 start/stop 的诊断事件，时间顺序（旧→新）。
   * 服务端还没上线这个字段时整块折叠面板都不渲染 —— 绝不因为契约未到位而崩。
   */
  diagnostics?: PublicAccessDiagnosticEntry[] | null;
}

/** POST /api/public-access/diagnose 的一条检查结果。 */
interface DiagnoseCheck {
  id: string;
  status: "ok" | "failed" | "skipped";
  /** 可安全展示的机器值（来源 / 地址 / 隧道 id / 代理 URL）。 */
  info?: string;
  /** 原始失败信息：只进 title，不直接当主文案。 */
  error?: string;
  durationMs?: number;
}

const DIAG_STAGE_KEYS: Record<string, string> = {
  preparing: "publicAccess.diag.stage.preparing",
  binary: "publicAccess.diag.stage.binary",
  proxy_transport: "publicAccess.diag.stage.proxy_transport",
  spawning: "publicAccess.diag.stage.spawning",
  registering: "publicAccess.diag.stage.registering",
  routes: "publicAccess.diag.stage.routes",
  binding: "publicAccess.diag.stage.binding",
  verifying: "publicAccess.diag.stage.verifying",
  online: "publicAccess.diag.stage.online",
  stopping: "publicAccess.diag.stage.stopping",
};

const DIAG_OUTCOME_KEYS: Record<string, string> = {
  started: "publicAccess.diag.outcome.started",
  succeeded: "publicAccess.diag.outcome.succeeded",
  failed: "publicAccess.diag.outcome.failed",
  cancelled: "publicAccess.diag.outcome.cancelled",
  retrying: "publicAccess.diag.outcome.retrying",
};

const DIAG_CHECK_KEYS: Record<string, string> = {
  binary: "publicAccess.diag.check.binary",
  proxy: "publicAccess.diag.check.proxy",
  token: "publicAccess.diag.check.token",
  dns: "publicAccess.diag.check.dns",
  origin: "publicAccess.diag.check.origin",
};

const DIAG_CHECK_STATUSES = new Set(["ok", "failed", "skipped"]);

/** 服务端返回值不可全信：只收形状正确的检查行，避免渲染层炸掉。 */
function parseDiagnoseChecks(value: unknown): DiagnoseCheck[] {
  if (!Array.isArray(value)) return [];
  const checks: DiagnoseCheck[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.status !== "string" || !DIAG_CHECK_STATUSES.has(record.status)) continue;
    checks.push({
      id: record.id,
      status: record.status as DiagnoseCheck["status"],
      ...(typeof record.info === "string" ? { info: record.info } : {}),
      ...(typeof record.error === "string" ? { error: record.error } : {}),
      ...(typeof record.durationMs === "number" && Number.isFinite(record.durationMs) ? { durationMs: record.durationMs } : {}),
    });
  }
  return checks;
}

/** 诊断事件同样按可选处理：只保留 stage/outcome 都在的行。 */
function parseDiagnostics(value: unknown): PublicAccessDiagnosticEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: PublicAccessDiagnosticEntry[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.stage !== "string" || typeof record.outcome !== "string") continue;
    if (!(record.outcome in DIAG_OUTCOME_KEYS)) continue;
    entries.push({
      stage: record.stage,
      outcome: record.outcome as PublicAccessDiagnosticEntry["outcome"],
      ...(typeof record.durationMs === "number" && Number.isFinite(record.durationMs) ? { durationMs: record.durationMs } : {}),
      ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.details && typeof record.details === "object" ? { details: record.details as Record<string, unknown> } : {}),
    });
  }
  return entries;
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
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

interface WebAuthStatus {
  enabled: boolean;
  authenticated?: boolean;
  source: "env" | "stored" | null;
}

/** GET /api/public-access/devices 的一行设备（不含任何令牌/哈希）。 */
interface PublicAccessDeviceView {
  id: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
}

/** 等待在电脑上批准/拒绝的配对请求。 */
interface PublicAccessPendingPairing {
  id: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "rejected";
}

interface PublicAccessDevicesResponse {
  devices: PublicAccessDeviceView[];
  pending: PublicAccessPendingPairing[];
  pairing: { active: boolean; expiresAt: number | null };
}

/** POST /api/public-access/pair/qr 的响应：二维码内容 + 服务端生成的 SVG。 */
interface PublicAccessPairingQr {
  url: string;
  svg: string;
  expiresAt: number;
}

const DEVICE_POLL_MS = 2500;

const LIVE_STATES = new Set(["connecting", "reconnecting", "online"]);
const POLL_MS = 2000;

const MODES = ["quick", "named"] as const;

/**
 * Settings › General › Server: the listener port and the Cloudflare tunnel
 * (see lib/public-access/*). The tunnel points at this server's own port, so the
 * only thing the user picks is how Cloudflare publishes it and where.
 */
export function ServerSection() {
  const { t, locale } = useI18n();
  const [server, setServer] = useState<ServerSettingsResponse | null>(null);
  const [publicAccess, setPublicAccess] = useState<PublicAccessResponse | null>(null);
  const [portDraft, setPortDraft] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  // Token 是长 base64，粘贴后默认不可见；显示切换让用户能核对贴进去的内容。
  const [tokenVisible, setTokenVisible] = useState(false);
  const [customUrlDraft, setCustomUrlDraft] = useState("");
  // 模式是**草稿**：旧实现切换下拉时立即 PUT，从 quick 切到 named 时 token
  // 还没填，服务端直接回「named tunnel needs a token」，用户看到的是一次
  // 报错的切换。现在切模式只改本地，Token/域名填好后由「保存配置」一起提交。
  const [modeDraft, setModeDraft] = useState<"quick" | "named">("quick");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 复制反馈：失败也要有提示，连点时前一个复位定时器不能提前清掉后一个提示。
  const { copied, failed: copyFailed, copy } = useCopyFeedback();
  // 「下载 cloudflared」自己的状态：它是一次可能长达十几分钟的子进程下载，**不能**借用
  // 全局 busy —— 那会把端口/模式/Token/Save 一起锁死，用户会以为整个设置页坏了（打包版
  // 实际就是这个观感）。失败文案走本地化固定文案，原始 stderr 只进 title。
  const [installing, setInstalling] = useState(false);
  const [installDetail, setInstallDetail] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // d5-1：start/stop 的 POST 只更新视图、从不续排轮询链——从非 live 态启动隧道时
  // 状态会永远停在 connecting。POST 成功后踢一次轮询 effect 重新探测。
  const [publicAccessPollKick, setPublicAccessPollKick] = useState(0);
  // Web 密码（Settings › General › Server）：状态来自 GET /api/web-auth 的
  // { enabled, source }；表单自己的 busy/提示独立，避免与端口/隧道互相锁死。
  const [webAuth, setWebAuth] = useState<WebAuthStatus | null>(null);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNext, setPwNext] = useState("");
  const [pwRepeat, setPwRepeat] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwNote, setPwNote] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  // 「检查配置」自检：独立状态，不借用全局 busy（自检可长达数秒，不能锁住开关）。
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnoseChecks, setDiagnoseChecks] = useState<DiagnoseCheck[] | null>(null);
  const [diagnoseError, setDiagnoseError] = useState<string | null>(null);
  // 「手机接入」（配对 + 设备表）：与隧道开关互不锁死，各自独立 busy/错误。
  const [mobileDevices, setMobileDevices] = useState<PublicAccessDevicesResponse | null>(null);
  const [pairingQr, setPairingQr] = useState<PublicAccessPairingQr | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [devicesKick, setDevicesKick] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const initialized = useRef(false);

  const loadWebAuth = useCallback(async () => {
    try {
      const response = await fetch("/api/web-auth", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = await response.json() as WebAuthStatus;
      setWebAuth({ enabled: next.enabled === true, source: next.source ?? null });
    } catch {
      setWebAuth(null);
    }
  }, []);

  useEffect(() => { void loadWebAuth(); }, [loadWebAuth]);

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
          setModeDraft(next.view.mode);
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

  // 「检查配置」：POST /api/public-access/diagnose（本机限定，只读检查）。
  // 结果只保留形状正确的行；失败按固定本地化文案提示，原始错误留在检查行 title 里。
  const runDiagnose = useCallback(async () => {
    setDiagnosing(true);
    setDiagnoseError(null);
    try {
      const response = await fetch("/api/public-access/diagnose", { method: "POST", cache: "no-store" });
      const body = await response.json().catch(() => ({})) as { checks?: unknown };
      if (!response.ok) {
        setDiagnoseChecks(null);
        setDiagnoseError(response.status === 403 ? t("publicAccess.localOnly") : t("publicAccess.diag.checkFailed"));
        return;
      }
      setDiagnoseChecks(parseDiagnoseChecks(body.checks));
    } catch {
      setDiagnoseChecks(null);
      setDiagnoseError(t("publicAccess.diag.checkFailed"));
    } finally {
      setDiagnosing(false);
    }
  }, [t]);

  const view = publicAccess?.view;

  // 「手机接入」轮询：二维码在屏幕上、或有人等着批准时每 2.5s 刷新设备表；
  // 其余时刻只在挂载/动作后拉一次（最后使用时间不是需要实时的数据）。
  const devicesLive = Boolean(pairingQr) || (mobileDevices?.pending.length ?? 0) > 0;
  useEffect(() => {
    if (!view?.publicUrl || !publicAccess?.local) {
      setMobileDevices(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/public-access/devices", { cache: "no-store" });
        if (!response.ok) return;
        const next = await response.json() as PublicAccessDevicesResponse;
        if (!cancelled) setMobileDevices(next);
      } catch {
        // 隧道/服务端抖一下：保留上一份列表，下一跳再试。
      }
    };
    void load();
    if (!devicesLive) return () => { cancelled = true; };
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, DEVICE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [view?.publicUrl, publicAccess?.local, devicesLive, devicesKick]);

  // 二维码倒计时；过期自动收起（手机已经扫走的 pending 请求不受影响，仍可在
  // 下面批准）。计时器只在二维码存在时跑。
  useEffect(() => {
    if (!pairingQr) return;
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairingQr]);
  useEffect(() => {
    if (pairingQr && pairingQr.expiresAt <= nowTick) setPairingQr(null);
  }, [pairingQr, nowTick]);

  // 生成新的配对二维码（旧码立即作废）：POST /api/public-access/pair/qr 只回本机。
  const showPairingQr = useCallback(async () => {
    setPairingBusy(true);
    setPairingError(null);
    try {
      const response = await fetch("/api/public-access/pair/qr", { method: "POST" });
      const body = await response.json().catch(() => ({})) as {
        url?: unknown; svg?: unknown; expiresAt?: unknown;
      };
      if (!response.ok || typeof body.url !== "string" || typeof body.svg !== "string" || typeof body.expiresAt !== "number") {
        setPairingError(response.status === 403 ? t("publicAccess.localOnly") : t("publicAccess.device.qrFailed"));
        return;
      }
      setPairingQr({ url: body.url, svg: body.svg, expiresAt: body.expiresAt });
      setNowTick(Date.now());
      setDevicesKick((kick) => kick + 1);
    } catch {
      setPairingError(t("publicAccess.device.qrFailed"));
    } finally {
      setPairingBusy(false);
    }
  }, [t]);

  // 批准 / 拒绝一台在等待的手机。
  const answerPairing = useCallback(async (id: string, action: "approve" | "reject") => {
    setPairingBusy(true);
    setPairingError(null);
    try {
      const response = await fetch(`/api/public-access/pair/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        setPairingError(response.status === 403 ? t("publicAccess.localOnly") : t("publicAccess.device.answerFailed"));
      }
      setDevicesKick((kick) => kick + 1);
    } catch {
      setPairingError(t("publicAccess.device.answerFailed"));
    } finally {
      setPairingBusy(false);
    }
  }, [t]);

  // 撤销一台已配对手机：下一次请求就验不过。失败时把错误留在面板上，调用方据此保持确认框。
  const revokePhone = useCallback(async (id: string): Promise<boolean> => {
    setPairingBusy(true);
    setPairingError(null);
    try {
      const response = await fetch(`/api/public-access/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) {
        setPairingError(response.status === 403 ? t("publicAccess.localOnly") : t("publicAccess.device.revokeFailed"));
      }
      setDevicesKick((kick) => kick + 1);
      return response.ok;
    } catch {
      setPairingError(t("publicAccess.device.revokeFailed"));
      return false;
    } finally {
      setPairingBusy(false);
    }
  }, [t]);

  // PUT/DELETE /api/web-auth/password 的错误码 → 本地化文案；原始 error 只进 title。
  const passwordErrorText = useCallback((status: number, body: Record<string, unknown>): string => {
    const code = typeof body.code === "string" ? body.code : "";
    if (code === "managed-by-env") return t("webPassword.error.managedByEnv");
    if (code === "invalid-current") return t("webPassword.error.invalidCurrent");
    if (code === "invalid-new") return t("webPassword.error.invalidNew");
    if (code === "local-only" || status === 403) return t("publicAccess.localOnly");
    if (status === 429) {
      const retryAfterMs = typeof body.retryAfterMs === "number" ? body.retryAfterMs : 1000;
      const seconds = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : 1;
      return t("auth.tooManyAttempts", { seconds });
    }
    return t("webPassword.error.failed");
  }, [t]);

  const savePassword = useCallback(async () => {
    if (pwNext !== pwRepeat) {
      setPwError(t("webPassword.mismatch"));
      return;
    }
    setPwBusy(true);
    setPwError(null);
    setPwNote(null);
    try {
      const response = await fetch("/api/web-auth/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(webAuth?.source === "stored" ? { currentPassword: pwCurrent } : {}),
          newPassword: pwNext,
        }),
      });
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        setPwError(passwordErrorText(response.status, body));
        return;
      }
      setPwCurrent("");
      setPwNext("");
      setPwRepeat("");
      setPwNote(t("webPassword.saved"));
      await loadWebAuth();
    } catch {
      setPwError(t("webPassword.error.failed"));
    } finally {
      setPwBusy(false);
    }
  }, [loadWebAuth, passwordErrorText, pwCurrent, pwNext, pwRepeat, t, webAuth?.source]);

  // Both destructive actions below are irreversible for the user (the password is
  // removed from the server, a paired phone loses its device token), and the DELETE
  // routes only check `isLocalRequest` — no password re-entry. Confirm first, the
  // same way conversation deletion does.
  const [clearPasswordOpen, setClearPasswordOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);

  const clearPassword = useCallback(async (): Promise<boolean> => {
    setPwBusy(true);
    setPwError(null);
    setPwNote(null);
    try {
      const response = await fetch("/api/web-auth/password", { method: "DELETE" });
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        setPwError(passwordErrorText(response.status, body));
        return false;
      }
      setPwNote(t("webPassword.cleared"));
      await loadWebAuth();
      return true;
    } catch {
      setPwError(t("webPassword.error.failed"));
      return false;
    } finally {
      setPwBusy(false);
    }
  }, [loadWebAuth, passwordErrorText, t]);

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

  // 每类错误的**可执行**提示：只说「失败」用户无从下手，这里给出下一步该改哪里。
  // 键名写死（字面量 t() 调用），由 i18n 的 usage/registry 测试兜住三语齐备。
  const errorHint = (() => {
    if (!view?.error) return null;
    switch (view.error) {
      case "token":
        return t("publicAccess.hint.token");
      case "route":
        return t("publicAccess.hint.route", { port: view.localPort });
      case "proxy":
        return t("publicAccess.hint.proxy");
      case "network":
        return t("publicAccess.hint.network");
      case "configuration":
        return t("publicAccess.hint.configuration");
      case "runtime":
        return t("publicAccess.hint.runtime");
      case "stop":
        return t("publicAccess.hint.stop");
      default:
        return null;
    }
  })();

  // 诊断事件（可选字段）：服务端尚未提供时整块不渲染。
  const diagnostics = parseDiagnostics(view?.diagnostics);

  // 固定域名绑定向导的状态+指引（named + customUrl 才有意义；quick 的地址由
  // Cloudflare 分配，没有绑定概念，状态行走上面的 statusText）。
  const bindingText = (() => {
    if (!view || view.mode !== "named" || !view.customUrl) return null;
    let hostname = view.customUrl;
    try { hostname = new URL(view.customUrl).hostname; } catch { /* 校验前用户可能仍在输入 */ }
    const binding = view.domainBinding;
    if (!binding) {
      // 启动中还没收到第一次路由推送：向导先停在「等待」，别让整块消失。
      return view.state === "connecting" || view.state === "reconnecting" || view.state === "online"
        ? t("publicAccess.binding.polling")
        : null;
    }
    switch (binding.state) {
      case "polling": return t("publicAccess.binding.polling");
      case "bound": return t("publicAccess.binding.bound");
      case "unbound":
        return binding.reason === "service-mismatch"
          ? t("publicAccess.binding.unboundService", { hostname })
          : t("publicAccess.binding.unboundOther", { hostname, port: view.localPort });
      case "timeout": return t("publicAccess.binding.timeout");
    }
  })();

  const diagnoseLabel = (id: string): string => {
    const key = DIAG_CHECK_KEYS[id];
    return key ? t(key) : id;
  };
  const diagnoseStatusLabel = (status: DiagnoseCheck["status"]): string => {
    switch (status) {
      case "ok": return t("publicAccess.diag.status.ok");
      case "failed": return t("publicAccess.diag.status.failed");
      case "skipped": return t("publicAccess.diag.status.skipped");
      default: return status;
    }
  };
  const diagnosticStageLabel = (stage: string): string => {
    const key = DIAG_STAGE_KEYS[stage];
    return key ? t(key) : stage;
  };
  const diagnosticOutcomeLabel = (outcome: string): string => {
    const key = DIAG_OUTCOME_KEYS[outcome];
    return key ? t(key) : outcome;
  };

  // Web 密码状态行；表单只在「记录来源」时要求当前密码，env 来源时整块只读。
  const webPasswordStatus = (() => {
    if (!webAuth) return t("server.loading");
    if (webAuth.source === "env") return t("webPassword.statusEnv");
    if (webAuth.source === "stored") return t("webPassword.statusStored");
    return t("webPassword.statusNone");
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
            <span className="settings-option-title">{t("webPassword.title")}</span>
            <span className="settings-option-hint" role="status">{pwNote ?? webPasswordStatus}</span>
          </span>
          {webAuth?.source === "stored" && (
            <ConfigButton
              className="settings-option-action"
              variant="ghost"
              disabled={pwBusy}
              onClick={() => setClearPasswordOpen(true)}
            >
              {t("webPassword.clearPassword")}
            </ConfigButton>
          )}
        </div>

        {webAuth && webAuth.source !== "env" && (
          <>
            <label className="remote-access-step">
              {webAuth.source === "stored" && (
                <>
                  <span className="settings-option-hint">{t("webPassword.current")}</span>
                  <input
                    className="mcp-add-input"
                    type="password"
                    value={pwCurrent}
                    autoComplete="current-password"
                    disabled={pwBusy}
                    spellCheck={false}
                    onChange={(event) => setPwCurrent(event.target.value)}
                  />
                </>
              )}
              <span className="settings-option-hint">{t("webPassword.new")}</span>
              <input
                className="mcp-add-input"
                type="password"
                value={pwNext}
                autoComplete="new-password"
                disabled={pwBusy}
                spellCheck={false}
                onChange={(event) => setPwNext(event.target.value)}
              />
              <span className="settings-option-hint">{t("webPassword.confirm")}</span>
              <input
                className="mcp-add-input"
                type="password"
                value={pwRepeat}
                autoComplete="new-password"
                disabled={pwBusy}
                spellCheck={false}
                onChange={(event) => setPwRepeat(event.target.value)}
              />
            </label>
            <ConfigButton
              variant="ghost"
              disabled={pwBusy || pwNext.length === 0}
              onClick={() => void savePassword()}
            >
              {webAuth.source === "stored" ? t("webPassword.changePassword") : t("webPassword.setPassword")}
            </ConfigButton>
          </>
        )}
        {pwError && <span className="settings-option-hint" role="alert">{pwError}</span>}

        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("publicAccess.title")}</span>
            <span className="settings-option-hint" role="status">{statusText}</span>
          </span>
          {view?.publicUrl && (
            <div className="settings-action-group">
              <ConfigButton
                className="settings-option-action"
                variant="ghost"
                onClick={() => { void copy(view.publicUrl!); }}
              >
                {copyFailed ? t("i18n.copyFailed") : copied ? t("publicAccess.copied") : t("publicAccess.copy")}
              </ConfigButton>
              <ConfigButton
                className="settings-option-action"
                variant="ghost"
                onClick={() => void openExternal(view.publicUrl!)}
              >
                {t("publicAccess.open")}
              </ConfigButton>
            </div>
          )}
        </div>

        {errorHint && (
          <p className="public-access-error-hint" role="alert">{errorHint}</p>
        )}
        {view && (
          <span className="settings-option-hint public-access-port-hint">
            {t("publicAccess.hint.portActual", { port: view.localPort })}
          </span>
        )}

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
                <span className="settings-option-hint">{modeDraft === "quick" ? t("publicAccess.quickHint") : t("publicAccess.namedHint")}</span>
              </span>
              <AppSelect
                aria-label={t("publicAccess.mode")}
                value={modeDraft}
                onValueChange={(next) => setModeDraft(next === "named" ? "named" : "quick")}
                options={MODES.map((mode) => ({ value: mode, label: t(`publicAccess.${mode}`) }))}
                disabled={busy || !publicAccess?.local}
              />
            </div>

            {modeDraft === "named" && (
              <>
                <label className="remote-access-step">
                  <span className="settings-option-hint">{t("publicAccess.token")}</span>
                  <input
                    className="mcp-add-input"
                    type={tokenVisible ? "text" : "password"}
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
                {tokenDraft.length > 0 && (
                  <ConfigButton
                    variant="ghost"
                    size="small"
                    onClick={() => setTokenVisible((visible) => !visible)}
                  >
                    {tokenVisible ? t("publicAccess.hideToken") : t("publicAccess.showToken")}
                  </ConfigButton>
                )}
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
                {bindingText && (
                  <div className="settings-option">
                    <span className="settings-option-text">
                      <span className="settings-option-title">{t("publicAccess.binding.title")}</span>
                      <span className="settings-option-hint" role="status">{bindingText}</span>
                    </span>
                  </div>
                )}
              </>
            )}

            {/* 保存配置始终显示：模式、Token、域名一起提交。模式切换不再
                立即 PUT，半填的配置（尤其是 named 缺 token）不会先报错。 */}
            <ConfigButton
              variant="ghost"
              disabled={busy || !publicAccess?.local || (modeDraft === "named" && !view.tokenSet && !tokenDraft.trim())}
              onClick={() => void call("/api/public-access", json({
                enabled: view.enabled,
                mode: modeDraft,
                customUrl: modeDraft === "named" ? customUrlDraft.trim() : "",
                ...(tokenDraft.trim() ? { token: tokenDraft.trim() } : {}),
              }), "public-access").then((ok) => {
                if (!ok) return;
                setTokenDraft("");
                setNote(t("publicAccess.savedConfiguration"));
              })}
            >
              {t("publicAccess.saveConfiguration")}
            </ConfigButton>

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
                <span className="settings-option-hint">
                  {view.restoredByAutoStart ? t("publicAccess.autoStartRestored") : t("publicAccess.autoStartHint")}
                </span>
              </span>
              <ConfigSwitch
                checked={view.autoStart}
                disabled={!publicAccess?.local || busy}
                label={t("publicAccess.autoStart")}
                onChange={(next) => void action({ action: "auto-start", enabled: next })}
              />
            </div>

            <div className="public-access-mobile">
              <div className="settings-option">
                <span className="settings-option-text">
                  <span className="settings-option-title">{t("publicAccess.device.title")}</span>
                  <span className="settings-option-hint">
                    {view.publicUrl ? t("publicAccess.device.hint") : t("publicAccess.device.tunnelOffline")}
                  </span>
                </span>
                {view.publicUrl && publicAccess?.local && (
                  <ConfigButton
                    className="settings-option-action"
                    disabled={pairingBusy}
                    onClick={() => void showPairingQr()}
                  >
                    {pairingQr ? t("publicAccess.device.regenerate") : t("publicAccess.device.generate")}
                  </ConfigButton>
                )}
              </div>

              {pairingQr && (
                <div className="public-access-pairing">
                  {/* 服务端用 qrcode-generator 生成的 SVG（与 RelaySection 同一个库），不是用户输入。 */}
                  <div className="relay-qr" dangerouslySetInnerHTML={{ __html: pairingQr.svg }} />
                  <span className="settings-option-hint">
                    {t("publicAccess.device.expires", {
                      minutes: Math.max(1, Math.ceil((pairingQr.expiresAt - nowTick) / 60_000)),
                    })}
                  </span>
                  <span className="settings-option-hint">{t("publicAccess.device.qrHint")}</span>
                </div>
              )}

              {mobileDevices?.pending.map((request) => (
                <div key={request.id} className="settings-option public-access-device-pending" role="alert">
                  <span className="settings-option-text">
                    <span className="settings-option-title">
                      {t("publicAccess.device.pendingTitle", { name: request.name })}
                    </span>
                    <span className="settings-option-hint">{t("publicAccess.device.pendingHint")}</span>
                  </span>
                  <span className="settings-action-group">
                    <ConfigButton variant="ghost" disabled={pairingBusy} onClick={() => void answerPairing(request.id, "reject")}>
                      {t("publicAccess.device.reject")}
                    </ConfigButton>
                    <ConfigButton disabled={pairingBusy} onClick={() => void answerPairing(request.id, "approve")}>
                      {t("publicAccess.device.approve")}
                    </ConfigButton>
                  </span>
                </div>
              ))}

              {(mobileDevices?.devices.length ?? 0) > 0 && (
                <div className="public-access-device-list">
                  <span className="settings-option-hint">
                    {t("publicAccess.device.pairedCount", { count: mobileDevices!.devices.length })}
                  </span>
                  {mobileDevices!.devices.map((device) => (
                    <div key={device.id} className="settings-option">
                      <span className="settings-option-text">
                        <span className="settings-option-title">{device.name}</span>
                        <span className="settings-option-hint">
                          {t("publicAccess.device.lastUsed", {
                            time: device.lastUsedAt
                              ? formatRelativeTime(new Date(device.lastUsedAt), locale)
                              : t("publicAccess.device.neverUsed"),
                          })}
                        </span>
                      </span>
                      {publicAccess?.local && (
                        <ConfigButton
                          className="settings-option-action"
                          variant="ghost"
                          disabled={pairingBusy}
                          onClick={() => setRevokeTarget({ id: device.id, name: device.name })}
                        >
                          {t("publicAccess.device.revoke")}
                        </ConfigButton>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {view.publicUrl && mobileDevices && mobileDevices.devices.length === 0 && (
                <span className="settings-option-hint public-access-device-empty">{t("publicAccess.device.empty")}</span>
              )}
              {pairingError && <span className="settings-option-hint" role="alert">{pairingError}</span>}
            </div>

            {diagnostics.length > 0 && (
              <details className="public-access-diag">
                <summary className="public-access-diag-summary">{t("publicAccess.diag.title")}</summary>
                <ol className="public-access-diag-list">
                  {diagnostics.map((entry, index) => (
                    <li
                      key={`${entry.stage}-${entry.outcome}-${index}`}
                      className={`public-access-diag-row${entry.outcome === "failed" ? " is-failed" : ""}`}
                      title={typeof entry.error === "string" ? entry.error : undefined}
                    >
                      <span className="public-access-diag-stage">{diagnosticStageLabel(entry.stage)}</span>
                      <span className="public-access-diag-outcome">{diagnosticOutcomeLabel(entry.outcome)}</span>
                      {typeof entry.durationMs === "number" && (
                        <span className="public-access-diag-duration">{formatDuration(entry.durationMs)}</span>
                      )}
                      {entry.reason && <span className="public-access-diag-reason">{entry.reason}</span>}
                    </li>
                  ))}
                </ol>
              </details>
            )}

            <div className="settings-option">
              <span className="settings-option-text">
                <span className="settings-option-title">{t("publicAccess.diag.check")}</span>
                <span className="settings-option-hint" role="status">
                  {diagnoseError ?? (!publicAccess?.local
                    ? t("publicAccess.localOnly")
                    : diagnosing ? t("publicAccess.diag.checking") : t("publicAccess.diag.checkHint"))}
                </span>
              </span>
              <ConfigButton
                className="settings-option-action"
                variant="ghost"
                disabled={!publicAccess?.local || diagnosing}
                onClick={() => void runDiagnose()}
              >
                {diagnosing ? t("publicAccess.diag.checking") : t("publicAccess.diag.check")}
              </ConfigButton>
            </div>
            {diagnoseChecks && diagnoseChecks.length > 0 && (
              <ul className="public-access-check-list" aria-label={t("publicAccess.diag.check")}>
                {diagnoseChecks.map((check) => (
                  <li
                    key={check.id}
                    className={`public-access-check-row is-${check.status}`}
                    title={check.error}
                  >
                    <span className="public-access-check-label">{diagnoseLabel(check.id)}</span>
                    <span className="public-access-check-status">{diagnoseStatusLabel(check.status)}</span>
                    {check.info && <code className="public-access-check-info">{check.info}</code>}
                    {typeof check.durationMs === "number" && (
                      <span className="public-access-check-duration">{formatDuration(check.durationMs)}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {error && (
          <span className="settings-option-hint" role="alert" title={installDetail ?? undefined}>
            {error}
          </span>
        )}
      </div>
      {/* Portaled to <body>: the Settings surface keeps a transform from its entry
          animation, which would make a fixed confirm layer relative to (and clipped
          by) the dialog instead of the viewport. ChatConfirmDialog supplies the
          stacked escape (one Esc closes only this layer) and the Tab trap. */}
      {clearPasswordOpen && createPortal(
        <ChatConfirmDialog
          title={t("webPassword.clearConfirmTitle")}
          body={t("webPassword.clearConfirmBody")}
          confirmLabel={t("webPassword.clearPassword")}
          cancelLabel={t("i18n.cancel")}
          danger
          busy={pwBusy}
          error={pwError}
          onCancel={() => { if (!pwBusy) { setClearPasswordOpen(false); setPwError(null); } }}
          onConfirm={() => { void clearPassword().then((ok) => { if (ok) setClearPasswordOpen(false); }); }}
        />,
        document.body,
      )}
      {revokeTarget && createPortal(
        <ChatConfirmDialog
          title={t("publicAccess.device.revokeConfirmTitle")}
          subject={revokeTarget.name}
          body={t("publicAccess.device.revokeConfirmBody")}
          confirmLabel={t("publicAccess.device.revoke")}
          cancelLabel={t("i18n.cancel")}
          danger
          busy={pairingBusy}
          error={pairingError}
          onCancel={() => { if (!pairingBusy) { setRevokeTarget(null); setPairingError(null); } }}
          onConfirm={() => { void revokePhone(revokeTarget.id).then((ok) => { if (ok) setRevokeTarget(null); }); }}
        />,
        document.body,
      )}
    </section>
  );
}
