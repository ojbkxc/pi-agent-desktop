import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readWebPasswordRecord, verifyWebPasswordHash } from "./web-password-store.ts";

export const PI_WEB_SESSION_COOKIE = "pi_web_session";
export const PI_WEB_SESSION_MAX_AGE = 60 * 60 * 24 * 30;

function hashSecret(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secretsEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(hashSecret(actual), hashSecret(expected));
}

/** 环境变量来源：非空才算设置。 */
function envWebPassword(): string | undefined {
  const value = process.env.PI_WEB_PASSWORD;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The web password has two sources: the `PI_WEB_PASSWORD` environment variable
 * (which wins while set) and the scrypt record Settings writes into
 * `~/.pi/agent/pi-web/settings.json` (lib/web-password-store.ts). With neither,
 * password protection is off.
 *
 * An explicit argument keeps the old env-only semantics (tests and callers with
 * a dependency-injected env rely on it); a call without arguments resolves both
 * sources in priority order.
 */
export function isWebPasswordEnabled(password?: string): boolean {
  if (arguments.length > 0) {
    return typeof password === "string" && password.length > 0;
  }
  return envWebPassword() !== undefined || readWebPasswordRecord() !== null;
}

/**
 * 同上的双来源判定，但显式给 env 值的调用方（lib/public-access/manager 注入的
 * spawn env）仍能带上它：非空 → true，否则回落到进程环境与设置文件。
 */
export function isWebPasswordSourceActive(envPassword?: string): boolean {
  if (typeof envPassword === "string" && envPassword.length > 0) return true;
  return envWebPassword() !== undefined || readWebPasswordRecord() !== null;
}

/** 当前生效的密码来源；null 表示未设密码。env 在时遮蔽设置文件里的记录。 */
export function webPasswordSource(): "env" | "stored" | null {
  if (envWebPassword() !== undefined) return "env";
  return readWebPasswordRecord() ? "stored" : null;
}

export function isValidWebPassword(suppliedPassword: string, password?: string): boolean {
  if (arguments.length >= 2) {
    return isWebPasswordEnabled(password) && secretsEqual(suppliedPassword, password as string);
  }
  const env = envWebPassword();
  if (env !== undefined) return secretsEqual(suppliedPassword, env);
  const record = readWebPasswordRecord();
  return record !== null && verifyWebPasswordHash(suppliedPassword, record);
}

function parseBasicCredentials(authorization: string): { username: string; password: string } | null {
  const match = /^Basic\s+(\S+)$/i.exec(authorization);
  if (!match) return null;

  let credentials: string;
  try {
    const decoded = Buffer.from(match[1], "base64");
    if (decoded.toString("base64") !== match[1]) return null;
    credentials = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    return null;
  }

  const separator = credentials.indexOf(":");
  if (separator === -1) return null;

  return {
    username: credentials.slice(0, separator),
    password: credentials.slice(separator + 1),
  };
}

/**
 * `Authorization: Basic` 兼容（curl / 脚本 / 第三方客户端）。
 *
 * **用户名不参与校验**：口令是唯一凭据，用户名可任意（含空串）。用户只需要在
 * `/login` 里输入密码；浏览器不再收到 Basic 挑战（`WWW-Authenticate` 已从
 * `proxy.ts` 移除），所以不会弹出带「用户名」的原生对话框。
 */
export function isValidBasicAuthorization(authorization: string | null, password?: string): boolean {
  const explicit = arguments.length >= 2;
  if (explicit ? !isWebPasswordEnabled(password) : !isWebPasswordEnabled()) return false;
  if (!authorization) return false;

  const credentials = parseBasicCredentials(authorization);
  if (!credentials) return false;

  return explicit
    ? isValidWebPassword(credentials.password, password)
    : isValidWebPassword(credentials.password);
}

function sessionSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`pi-web-session:${payload}`, "utf8").digest("hex");
}

/**
 * 会话 token 的签名密钥：env 来源用明文口令（与上游一致）；记录来源用存储的
 * hash hex。用 hash 而不是口令有两个效果：验证方（proxy）不需要跑 scrypt 就能
 * 验 HMAC，而且改密必然轮换 hash —— 旧签发的 token 全部失效，正好是「改密后
 * 旧 session 失效」的实现。两个来源都要求 0600 的本机文件/进程环境，信任面等价。
 */
function activeSessionSecret(): string | undefined {
  const env = envWebPassword();
  if (env !== undefined) return env;
  return readWebPasswordRecord()?.hash;
}

export function createWebSessionToken(
  password?: string,
  now = Date.now(),
  nonce = randomBytes(16).toString("hex"),
): string {
  const secret = arguments.length >= 1 ? (password as string) : activeSessionSecret();
  if (!secret) throw new Error("No web password is configured");
  const payload = `v1.${Math.floor(now / 1000) + PI_WEB_SESSION_MAX_AGE}.${nonce}`;
  return `${payload}.${sessionSignature(payload, secret)}`;
}

export function isValidWebSessionToken(
  token: string | undefined,
  password?: string,
  now = Date.now(),
): boolean {
  const secret = arguments.length >= 2
    ? (isWebPasswordEnabled(password) ? (password as string) : undefined)
    : activeSessionSecret();
  if (!token || !secret) return false;

  const match = /^(v1\.(\d+)\.[a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
  if (!match) return false;

  const expiresAt = Number(match[2]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) return false;
  return secretsEqual(match[3], sessionSignature(match[1], secret));
}
