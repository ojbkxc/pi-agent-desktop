import { execFile } from "node:child_process";
import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "./artifact-settings";
import { applyGlobalFetchForProxy, installHttpDispatcher } from "./http-dispatcher";

/**
 * 会话流量的网络代理（设置 › 通用 › 网络代理）。
 *
 * 为什么需要它：pi 的模型请求都由**本机的 node 服务端**发出（浏览器只跟 127.0.0.1 说话），
 * 而 node 的 `fetch` **不读系统代理**（Windows 的 WinINET 设置、macOS 的网络偏好都不看）。
 * 用户把系统代理打开也没用 —— 所以必须有一个入口把代理显式交给服务端。
 *
 * 服务端本来就有代理能力：`lib/http-dispatcher.ts` 装的 `undici.EnvHttpProxyAgent` 读
 * `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`。缺的是「谁来写这几个环境变量」+「让全局 fetch
 * 真的用上它」（Next 会用自己的补丁版盖掉 `globalThis.fetch`，见 `applyGlobalFetchForProxy`）
 * + 一个界面，也就是这一项。
 *
 * 三档语义（对齐 cc-haha 的 direct / system / manual；**默认 direct**，不配就不改变任何行为）：
 *   direct —— 不走代理，并且**忽略**外部环境变量（`NO_PROXY=*`），否则从带代理的 shell
 *             启动的桌面端会"设了直连却还在走代理"。
 *   system —— 读操作系统的代理设置（Windows 注册表 WinINET / macOS `scutil --proxy` /
 *             其它平台的环境变量）；系统没配 → 等价于直连。
 *   manual —— 用户填的 `http://host:port`（只支持 HTTP/HTTPS，SOCKS 与 PAC 不支持）。
 *
 * 生效范围与不生效范围：写进 `process.env` + 重装 dispatcher + 换掉全局 `fetch`，所以
 * **同进程**的所有出站请求（模型调用、市场/插件下载、技能安装）都走它；子进程（MCP server、
 * `npx`）继承环境变量。**不覆盖**应用自身的更新检查与安装包下载 —— 那条路走 Rust 的
 * tauri updater，是另一个进程。
 *
 * `NO_PROXY` 永远包含回环：本机自己的服务、本地 MCP 的 HTTP 端点不该被绕出去。
 */
export const NETWORK_PROXY_SETTINGS_KEY = "networkProxy";

export const NETWORK_PROXY_MODES = ["direct", "system", "manual"] as const;
export type NetworkProxyMode = (typeof NETWORK_PROXY_MODES)[number];

/** 始终绕过代理的目标；`127.0.0.1` 是**目标**而非代理地址，所以写在这里不影响
 *  代理本身就是本机的情况（Clash 默认 `127.0.0.1:7890`）。 */
export const LOOPBACK_NO_PROXY_ENTRIES = ["localhost", "127.0.0.1", "::1"] as const;

/** 支持的代理协议；SOCKS 与 PAC 明确不支持（undici 也不支持）。 */
const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:"]);

export interface NetworkProxySettings {
  mode: NetworkProxyMode;
  /** 仅在 `manual` 档使用；缺省空串。 */
  url: string;
}

export interface NetworkProxyStatus extends NetworkProxySettings {
  /** 当前**实际**生效的代理 URL；null = 直连。 */
  activeProxy: string | null;
  /** `system` 档探测到的系统代理；null = 没探测到（或不是 system 档）。 */
  systemProxy: string | null;
  /** 本机请求才有权修改；远端（中继/Tailscale）只读。 */
  local: boolean;
}

export function isNetworkProxyMode(value: unknown): value is NetworkProxyMode {
  return typeof value === "string" && (NETWORK_PROXY_MODES as readonly string[]).includes(value);
}

/**
 * 归一化代理 URL：`host:port` 补成 `http://host:port`，只接受 http/https。
 * 不可用返回空串（读设置时当作没配，而不是抛错 —— 设置文件坏了不该让整个 app 起不来）。
 */
export function normalizeProxyUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withProtocol = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    return "";
  }
  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) return "";
  return withProtocol;
}

/** 读设置；文件缺失/损坏/字段非法一律回落「直连」。 */
export function readNetworkProxySettings(settingsPath = getPiWebSettingsPath()): NetworkProxySettings {
  const fallback: NetworkProxySettings = { mode: "direct", url: "" };
  try {
    const stored = readStored(settingsPath)[NETWORK_PROXY_SETTINGS_KEY];
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return fallback;
    const record = stored as Record<string, unknown>;
    return {
      mode: isNetworkProxyMode(record.mode) ? record.mode : fallback.mode,
      url: normalizeProxyUrl(record.url),
    };
  } catch {
    return fallback;
  }
}

/** 只改这一个键，Pi Web 设置文件里的其它键原样保留。 */
export function writeNetworkProxySettings(
  settings: NetworkProxySettings,
  settingsPath = getPiWebSettingsPath(),
): NetworkProxySettings {
  const next: NetworkProxySettings = {
    mode: isNetworkProxyMode(settings.mode) ? settings.mode : "direct",
    url: normalizeProxyUrl(settings.url),
  };
  updatePiWebSettings({ [NETWORK_PROXY_SETTINGS_KEY]: next }, settingsPath);
  return next;
}

/**
 * `reg query "HKCU\...\Internet Settings"` 的输出 → 代理 URL（None = 没开或没配）。
 *
 * 值形如 `ProxyServer  REG_SZ  127.0.0.1:7890`，也可以是
 * `http=127.0.0.1:7890;https=127.0.0.1:7891` —— 有分协议时优先 `https=`，因为模型端点都是
 * HTTPS。`ProxyEnable = 0x0` 表示系统代理关着。只有 PAC（`AutoConfigURL`）没有 `ProxyServer`
 * 时无法处理，返回 null（在界面上表现为「系统没有可用的代理」）。
 */
export function parseWindowsProxyRegistry(output: string): string | null {
  const enabled = /^\s*ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/im.exec(output);
  const server = /^\s*ProxyServer\s+REG_SZ\s+(.+?)\s*$/im.exec(output);
  if (!enabled || !server) return null;
  if (Number.parseInt(enabled[1], 16) === 0) return null;

  const raw = server[1].trim();
  if (!raw.includes("=")) return normalizeProxyUrl(raw) || null;
  const byProtocol = new Map<string, string>();
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    byProtocol.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
  }
  return normalizeProxyUrl(byProtocol.get("https") ?? byProtocol.get("http") ?? "") || null;
}

/** macOS `scutil --proxy` 的输出 → 代理 URL。优先 HTTPS，其次 HTTP。 */
export function parseMacSystemProxy(output: string): string | null {
  const values = new Map<string, string>();
  for (const match of output.matchAll(/^\s*([A-Za-z]+)\s*:\s*(\S+)\s*$/gm)) {
    values.set(match[1], match[2]);
  }
  const pick = (enableKey: string, hostKey: string, portKey: string): string => {
    if (values.get(enableKey) !== "1") return "";
    const host = values.get(hostKey);
    if (!host) return "";
    const port = values.get(portKey);
    return normalizeProxyUrl(port ? `${host}:${port}` : host);
  };
  return pick("HTTPSEnable", "HTTPSProxy", "HTTPSPort") || pick("HTTPEnable", "HTTPProxy", "HTTPPort") || null;
}

export type ProxyCommandRunner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string }>;

const runCommand: ProxyCommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5_000, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout) });
    });
  });

export interface DetectSystemProxyOptions {
  platform?: NodeJS.Platform;
  run?: ProxyCommandRunner;
}

/**
 * 探测系统代理。任何失败（命令不存在、超时、权限）都当作「没探测到」，
 * 由调用方回落到环境变量 —— 探测失败不该让发送消息失败。
 */
export async function detectSystemProxy(options: DetectSystemProxyOptions = {}): Promise<string | null> {
  const { platform = process.platform, run = runCommand } = options;
  try {
    if (platform === "win32") {
      const { stdout } = await run("reg", [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      ]);
      return parseWindowsProxyRegistry(stdout);
    }
    if (platform === "darwin") {
      const { stdout } = await run("scutil", ["--proxy"]);
      return parseMacSystemProxy(stdout);
    }
  } catch {
    return null;
  }
  return null;
}

/** 进程启动时的环境变量（在我们改动之前的原样），`system` 档在非 Windows/macOS 上回落到它。 */
function ambientProxyFromEnv(env: NodeJS.ProcessEnv): string {
  return normalizeProxyUrl(env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy ?? "");
}

/**
 * `NO_PROXY` 取值：回环 + 用户原来的排除项（两者都要，否则 direct 之外会丢掉用户自己的排除）。
 * `direct` 档例外：整个 `*`，连环境里带的代理一起忽略。
 *
 * 外部带来的 `*` 必须**剔除**：`*` 是「所有主机都不走代理」的通配，原样并进去会让
 * `direct` 之外的所有档位（含手动代理）一个请求都代理不出去 —— 本机 `NO_PROXY=*` 时
 * 实测过：装了代理也照样直连。
 */
function noProxyList(env: NodeJS.ProcessEnv): string {
  const existing = (env.NO_PROXY ?? env.no_proxy ?? "")
    .split(/[,\s]/)
    .map((entry) => entry.trim())
    .filter((entry) => Boolean(entry) && entry !== "*");
  return [...new Set([...existing, ...LOOPBACK_NO_PROXY_ENTRIES])].join(",");
}

export interface ResolvedProxyEnv {
  /** 生效的代理 URL；null = 直连。 */
  activeProxy: string | null;
  /** 要写进 `process.env` 的值；`undefined` 表示应当删除该键。 */
  env: {
    HTTP_PROXY?: string;
    HTTPS_PROXY?: string;
    NO_PROXY: string;
  };
}

/**
 * 设置 + 系统探测结果 → 应当写进环境变量的代理配置（纯函数，便于单测）。
 *
 * 注意 `direct` 与「system 探测不到」都会得到 `activeProxy: null`，但写法不同：
 * 前者 `NO_PROXY=*`（连外部环境变量一起忽略），后者保留用户的排除项。
 */
export function resolveProxyEnv(
  settings: NetworkProxySettings,
  systemProxy: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProxyEnv {
  if (settings.mode === "direct") {
    return { activeProxy: null, env: { NO_PROXY: "*" } };
  }
  // 外部带来的 `*` 会让这一档彻底不代理，先剔掉再算。
  const baseEnv = env.NO_PROXY?.trim() === "*" || env.no_proxy?.trim() === "*"
    ? { ...env, NO_PROXY: "", no_proxy: "" }
    : env;
  const url =
    settings.mode === "manual"
      ? normalizeProxyUrl(settings.url)
      : (systemProxy ?? ambientProxyFromEnv(baseEnv));
  if (!url) {
    return { activeProxy: null, env: { NO_PROXY: noProxyList(baseEnv) } };
  }
  return { activeProxy: url, env: { HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY: noProxyList(baseEnv) } };
}

/** 环境变量里我们接管的键（大写是我们写的，小写是外部可能带的）。 */
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;

export interface ApplyNetworkProxyOptions {
  settings?: NetworkProxySettings;
  settingsPath?: string;
  /** 探测到的系统代理；缺省时由 `detectSystemProxy()` 现探（可用 `systemProxy: null` 跳过探测）。 */
  systemProxy?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: ProxyCommandRunner;
  /** 跳过 dispatcher 重装（单测里不想碰全局 dispatcher 时用）。 */
  skipDispatcher?: boolean;
}

/**
 * 把设置应用到当前进程：写/删代理环境变量，重装 dispatcher，必要时换掉全局 `fetch`。
 *
 * 三件事都不可少：
 *   - `EnvHttpProxyAgent` 只在构造时读 `HTTP_PROXY` / `HTTPS_PROXY`，所以必须换新实例；
 *   - Next 在启动早期用自己的补丁版覆盖了 `globalThis.fetch`（包装的是 Node 内建 fetch，
 *     跟我们这个 npm undici 的 dispatcher 无关），所以**配了代理时必须换掉它**，否则请求
 *     根本不会经过代理 —— 不换的那次实测过：代理指到死端口，技能市场的实时源照样成功；
 *   - 环境变量照样要写：子进程（MCP server、`npx`）与 SDK 里按环境变量走代理的适配器都读它。
 *
 * 换 `fetch` 用 `close()` 之外的代价是 Next 那层补丁在代理开启期间不生效，见
 * `applyGlobalFetchForProxy` 的说明；`direct`/没探测到代理时会恢复原样。
 */
export async function applyNetworkProxy(options: ApplyNetworkProxyOptions = {}): Promise<NetworkProxyStatus> {
  const env = options.env ?? process.env;
  const settings = options.settings ?? readNetworkProxySettings(options.settingsPath);
  const systemProxy =
    options.systemProxy !== undefined
      ? options.systemProxy
      : settings.mode === "system"
        ? await detectSystemProxy({ platform: options.platform, run: options.run })
        : null;

  const resolved = resolveProxyEnv(settings, systemProxy, env);
  for (const key of PROXY_ENV_KEYS) delete env[key];
  for (const [key, value] of Object.entries(resolved.env)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  if (!options.skipDispatcher) {
    installHttpDispatcher({ force: true });
    applyGlobalFetchForProxy(resolved.activeProxy !== null);
  }

  return {
    ...settings,
    activeProxy: resolved.activeProxy,
    systemProxy,
    local: true,
  };
}

/** 只读状态（设置面板用）——不碰环境变量，不装 dispatcher。 */
export async function networkProxyStatus(
  options: Pick<ApplyNetworkProxyOptions, "settingsPath" | "env" | "platform" | "run"> & { local?: boolean } = {},
): Promise<NetworkProxyStatus> {
  const env = options.env ?? process.env;
  const settings = readNetworkProxySettings(options.settingsPath);
  const systemProxy =
    settings.mode === "system"
      ? await detectSystemProxy({ platform: options.platform, run: options.run })
      : null;
  return {
    ...settings,
    activeProxy: resolveProxyEnv(settings, systemProxy, env).activeProxy,
    systemProxy,
    local: options.local ?? true,
  };
}
