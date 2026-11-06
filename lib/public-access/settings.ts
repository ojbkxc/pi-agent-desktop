/**
 * Cloudflare 公网访问的配置层（服务端专用，不依赖 pi SDK）。
 *
 * 配置与 remoteAccess / artifactsPrompt 等共用同一个 `~/.pi/agent/pi-web/settings.json`，
 * 只占 `publicAccess` 一个键。proxy 与 request-security 每次请求都要读它，所以解析结果按
 * 文件的 mtime+size 缓存；任何写操作后清缓存（范式照抄 lib/remote-access.ts）。
 *
 * 校验规则移植自 cc-haha 的 desktop/src/lib/desktopHost/publicAccessConfiguration.ts：
 * 端口 1024–65535、origin 只收 https 且无凭据/路径、Tunnel Token 只解出隧道 id 不外泄 secret。
 */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file.ts";
import { remoteAccessSettingsPath } from "../remote-access.ts";

/** 本机网关端口缺省值；实际运行时以 process.env.PORT 为准。 */
export const DEFAULT_PUBLIC_ACCESS_PORT = 30141;
/** 同意条款版本；改动此值会让已开启的隧道在下次恢复时要求重新同意。 */
export const PUBLIC_ACCESS_CONSENT_VERSION = 1;

export type PublicAccessMode = "quick" | "named";

export interface PublicAccessConfig {
  /** 用户意图：是否希望隧道开启。 */
  enabled: boolean;
  mode: PublicAccessMode;
  /** 隧道指向的本机端口。 */
  localPort: number;
  /** 命名隧道的 Cloudflare Token；永不回读给前端。 */
  token: string;
  /** 命名隧道可选的首选入口 origin（https）。 */
  customUrl: string;
  autoStart: boolean;
  consentVersion: number;
  /** 运行期字段：隧道在线时的公网 origin；其余时刻为空串（由 manager 写/清）。 */
  origin: string;
}

const EMPTY: PublicAccessConfig = {
  enabled: false,
  mode: "quick",
  localPort: DEFAULT_PUBLIC_ACCESS_PORT,
  token: "",
  customUrl: "",
  autoStart: false,
  consentVersion: 0,
  origin: "",
};

/** 公网访问配置与 remoteAccess 同文件。 */
export function publicAccessSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return remoteAccessSettingsPath(env);
}

/** 只接受 https origin：无凭据、无路径、无查询串。 */
export function normalizePublicAccessOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const input = value.trim();
  if (!/^https:\/\//i.test(input) || /[\s\\?#@]/.test(input)) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function isLocalPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

/** 空串表示「未设置」，其余必须是 cloudflared 形态的凭据字面量。 */
export function isCloudflareTunnelToken(value: unknown): value is string {
  return typeof value === "string"
    && (value === "" || (value.length >= 32 && value.length <= 8192 && /^[A-Za-z0-9_+/=-]+$/.test(value)));
}

const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TUNNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64_RUN = /[A-Za-z0-9+/]{32,}={0,2}/g;

/**
 * 按 cloudflared 的读法解凭据：标准 base64 的 JSON `{a,t,s}`，`t` 是隧道 UUID。
 * 只返回 tunnelId —— secret 不离开本函数。
 */
export function readCloudflareTunnelToken(value: string): { tunnelId: string } | null {
  if (value.length > 8192 || !STANDARD_BASE64.test(value)) return null;
  try {
    const credential: unknown = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    if (!credential || typeof credential !== "object" || Array.isArray(credential)) return null;
    const { t, s } = credential as Record<string, unknown>;
    if (typeof t !== "string" || !TUNNEL_ID.test(t)) return null;
    if (typeof s !== "string" || !s || !STANDARD_BASE64.test(s)) return null;
    return { tunnelId: t.toLowerCase() };
  } catch {
    return null;
  }
}

export type CloudflareTunnelTokenInput =
  | { status: "found"; token: string; tunnelId: string }
  | { status: "missing" | "ambiguous" };

/** Cloudflare 只在安装命令里给出 token；从任意一段文本里把它抠出来。 */
export function findCloudflareTunnelToken(text: string): CloudflareTunnelTokenInput {
  const tokens = new Map<string, string>();
  for (const [candidate] of text.matchAll(BASE64_RUN)) {
    const credential = readCloudflareTunnelToken(candidate);
    if (credential) tokens.set(candidate, credential.tunnelId);
  }
  const [found, ...others] = tokens;
  if (!found) return { status: "missing" };
  if (others.length) return { status: "ambiguous" };
  return { status: "found", token: found[0], tunnelId: found[1] };
}

/** 隧道是否已配置到「可以启动」的程度。 */
export function isPublicAccessConfigured(config: PublicAccessConfig): boolean {
  if (!isLocalPort(config.localPort)) return false;
  if (config.mode === "named") return config.token.length > 0;
  return true;
}

function parsePublicAccess(value: unknown): PublicAccessConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const mode: PublicAccessMode = record.mode === "named" ? "named" : "quick";
  const customUrl = mode === "named" && typeof record.customUrl === "string" && record.customUrl !== ""
    ? normalizePublicAccessOrigin(record.customUrl) ?? ""
    : "";
  return {
    enabled: record.enabled === true,
    mode,
    localPort: isLocalPort(record.localPort) ? record.localPort : DEFAULT_PUBLIC_ACCESS_PORT,
    token: isCloudflareTunnelToken(record.token) ? record.token : "",
    customUrl,
    autoStart: record.autoStart === true,
    consentVersion: typeof record.consentVersion === "number" && Number.isInteger(record.consentVersion)
      ? record.consentVersion
      : 0,
    origin: typeof record.origin === "string" ? normalizePublicAccessOrigin(record.origin) ?? "" : "",
  };
}

let cache: { path: string; mtimeMs: number; size: number; config: PublicAccessConfig } | null = null;

/**
 * 读公网访问配置。文件缺失/不可读/损坏一律回退到「未配置」——fail-closed 只会让隧道开不起来。
 * 每请求调用，所以按 mtime+size 缓存解析结果。
 */
export function readPublicAccessConfig(settingsPath = publicAccessSettingsPath()): PublicAccessConfig {
  let stat;
  try {
    stat = statSync(settingsPath);
  } catch {
    cache = null;
    return EMPTY;
  }
  if (cache && cache.path === settingsPath && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.config;
  }
  let config: PublicAccessConfig = EMPTY;
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsePublicAccess((parsed as { publicAccess?: unknown }).publicAccess) ?? EMPTY;
    }
  } catch {
    config = EMPTY;
  }
  cache = { path: settingsPath, mtimeMs: stat.mtimeMs, size: stat.size, config };
  return config;
}

/** 隧道在线时的公网 origin，否则 null（供 request-security 判 Host）。 */
export function readPublicAccessOrigin(settingsPath = publicAccessSettingsPath()): string | null {
  const origin = readPublicAccessConfig(settingsPath).origin;
  return origin || null;
}

function readStored(settingsPath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw new Error("Invalid Pi Web settings: expected an object");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function persist(config: PublicAccessConfig, settingsPath: string): PublicAccessConfig {
  const stored = readStored(settingsPath);
  const next: Record<string, unknown> = { ...stored, version: 1, publicAccess: { ...config } };
  mkdirSync(dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify(next, null, 2));
  cache = null;
  return readPublicAccessConfig(settingsPath);
}

/** 保存配置，保留同一文件里的其它键。 */
export function writePublicAccessConfig(
  config: PublicAccessConfig,
  settingsPath = publicAccessSettingsPath(),
): PublicAccessConfig {
  return persist(config, settingsPath);
}

/**
 * 只更新运行期 origin（manager 专用），其余字段原样保留。
 * 传 null/"" 表示隧道已不在线。
 */
export function writePublicAccessOrigin(
  origin: string | null,
  settingsPath = publicAccessSettingsPath(),
): PublicAccessConfig {
  const current = readPublicAccessConfig(settingsPath);
  const normalized = origin ? normalizePublicAccessOrigin(origin) : null;
  return persist({ ...current, origin: normalized ?? "" }, settingsPath);
}

export type PublicAccessUpdateResult =
  | { ok: true; config: PublicAccessConfig }
  | { ok: false; error: string };

/**
 * 解析 PUT body。`token` 省略/空串表示保留原 token（前端永远拿不到已存的 token，
 * 不能要求它回传）。`origin` 是运行期字段，不接受外部写入。
 */
export function parsePublicAccessUpdate(
  value: unknown,
  current: PublicAccessConfig = readPublicAccessConfig(),
): PublicAccessUpdateResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Expected an object" };
  }
  const record = value as Record<string, unknown>;
  const mode: PublicAccessMode = record.mode === "named" ? "named" : "quick";
  if (record.mode !== undefined && record.mode !== "quick" && record.mode !== "named") {
    return { ok: false, error: "mode must be quick or named" };
  }
  if (record.localPort !== undefined && !isLocalPort(record.localPort)) {
    return { ok: false, error: "localPort must be an integer from 1024 to 65535" };
  }
  let token = current.token;
  if (record.token !== undefined) {
    if (isCloudflareTunnelToken(record.token)) {
      token = record.token;
    } else if (typeof record.token === "string") {
      // Cloudflare only shows the token inside its install command, so a pasted
      // command is the common case — lift the credential out of it.
      const found = findCloudflareTunnelToken(record.token);
      if (found.status !== "found") return { ok: false, error: "Invalid Cloudflare tunnel token" };
      token = found.token;
    } else {
      return { ok: false, error: "Invalid Cloudflare tunnel token" };
    }
  }
  let customUrl = "";
  if (mode === "named" && record.customUrl !== undefined && record.customUrl !== "") {
    const normalized = normalizePublicAccessOrigin(record.customUrl);
    if (!normalized) return { ok: false, error: "customUrl must be an https origin" };
    customUrl = normalized;
  }
  if (mode === "named" && token.length === 0) {
    return { ok: false, error: "A named tunnel needs a Cloudflare tunnel token" };
  }
  return {
    ok: true,
    config: {
      enabled: typeof record.enabled === "boolean" ? record.enabled : current.enabled,
      mode,
      localPort: isLocalPort(record.localPort) ? record.localPort : current.localPort,
      token,
      customUrl,
      autoStart: typeof record.autoStart === "boolean" ? record.autoStart : current.autoStart,
      consentVersion: current.consentVersion,
      origin: current.origin,
    },
  };
}

/**
 * 该请求是否来自「隧道当前公布的那个域名」。与 isApiRequestHostAllowed 里的
 * remoteAccess 分支同构：只做域名匹配；「必须已设 web 密码」由调用方
 * （lib/request-security.ts）一并判定，避免这里依赖 web-auth。
 */
export function isPublicAccessRequestHost(request: Request, config: PublicAccessConfig | null): boolean {
  if (!config || !config.origin) return false;
  const host = request.headers.get("host");
  if (!host || /[\s/@\\]/.test(host)) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase().replace(/\.$/, "");
    return hostname === new URL(config.origin).hostname.toLowerCase();
  } catch {
    return false;
  }
}
