import type { Locale, TranslationParams } from "./types";

type MessagesByLocale = Record<string, Record<string, string>>;

/**
 * 复数选择块：`{plural(count):单数:复数}`。
 *
 * 为什么要一个语法层的开关：文案里的计数（`teams.plan.memberCount` 之类）在英文下
 * 1 也得说 "1 member"，而消息本身只是纯字符串——**计数参数只有插值这一步才可见**，
 * 消息字典拿不到 count。所以单复数必须在插值层解决，消息侧只声明两个形态。
 *
 * 语法设计取舍（有意不用 ICU `{count, plural, one {…} other {…}}`）：
 * - ICU 形态的选项里有花括号，本仓库的占位符门禁（lib/i18n/usage.test.mjs 的
 *   `{([\w.-]+)}` 扫描）会把 `one {member}` 里的 `{member}` 当成占位符，
 *   要求调用点传 `member` —— 那是误报。这里用**无内层花括号**的形态，扫描器看不见。
 * - 选项文本不允许 `{`/`}`/`:`，够用（只需要词形，不需要嵌套插值）。
 * - 缺参数或参数不是数字 → 原样保留整个块（宁可露出原文，也不猜一个形态）。
 */
const PLURAL_BLOCK = /\{plural\(([\w.-]+)\):([^{}:]*):([^{}:]*)\}/g;

/**
 * 把复数块解析成单数/复数形态（不做 `{token}` 插值，交给 interpolateMessage 之后处理）。
 * @param message 原始翻译消息
 * @param params 插值参数（`plural(<name>)` 里的 name 从这里取）
 * @returns 已选定词形的消息；没有复数块或参数不可判定时原样返回
 */
export function resolvePluralBlocks(message: string, params: TranslationParams = {}): string {
  if (!message.includes("{plural(")) return message;
  return message.replace(PLURAL_BLOCK, (token, name: string, one: string, other: string) => {
    const raw = params[name];
    if (raw === undefined) return token;
    const count = Number(raw);
    if (!Number.isFinite(count)) return token;
    // 英文/中文的单数都取 "= 1"；0 与复数同形（"0 members"、"0 名成员"）。
    return count === 1 ? one : other;
  });
}

/**
 * 替换翻译消息中的简单插值占位符。
 * @param message 原始翻译消息
 * @param params 插值参数
 * @returns 完成参数替换后的消息
 */
export function interpolateMessage(message: string, params: TranslationParams = {}): string {
  return resolvePluralBlocks(message, params).replace(/\{([\w.-]+)\}/g, (token, name: string) => {
    const value = params[name];
    return value === undefined ? token : String(value);
  });
}

/**
 * 从当前语言和英语语言包中解析消息。
 * @param locale 当前语言
 * @param key 翻译 key
 * @param messages 各语言的消息字典
 * @param params 可选的插值参数
 * @returns 翻译结果，缺失时返回 key
 */
export function translateMessage(
  locale: Locale,
  key: string,
  messages: MessagesByLocale,
  params: TranslationParams = {},
): string {
  const message = messages[locale]?.[key] ?? messages.en?.[key];
  if (message === undefined) {
    if (process.env.NODE_ENV !== "production") console.warn(`[i18n] Missing translation: ${key}`);
    return key;
  }
  return interpolateMessage(message, params);
}

/**
 * 按当前语言格式化相对时间。
 * @param date 要格式化的时间
 * @param locale 当前语言
 * @param now 用于测试或特殊场景的当前时间
 * @returns locale-aware 的相对时间文本
 */
export function formatRelativeTime(date: Date | string, locale: Locale, now = new Date()): string {
  const target = date instanceof Date ? date : new Date(date);
  const diffMs = target.getTime() - now.getTime();
  const absMs = Math.abs(diffMs);
  const [unit, divisor] = absMs < 60_000
    ? ["second", 1_000]
    : absMs < 3_600_000
      ? ["minute", 60_000]
      : absMs < 86_400_000
        ? ["hour", 3_600_000]
        : ["day", 86_400_000];
  const value = Math.round(diffMs / divisor);
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(value, unit as Intl.RelativeTimeFormatUnit);
}

/**
 * 今天只显示时刻；更早的时间和会话列表一样用相对时间。
 * @param timestamp 毫秒时间戳
 * @param locale 当前语言
 * @param now 用于测试或特殊场景的当前时间
 * @returns 今天的时刻，或更早时间的相对时间文本
 */
export function formatUpdatedTime(timestamp: number, locale: Locale, now = new Date()): string {
  const target = new Date(timestamp);
  if (Number.isNaN(target.getTime())) return "";
  const isToday = target.getFullYear() === now.getFullYear()
    && target.getMonth() === now.getMonth()
    && target.getDate() === now.getDate();
  if (isToday) return target.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return formatRelativeTime(target, locale, now);
}

const COMPACT_UNITS: ReadonlyArray<readonly [Intl.NumberFormatOptions["unit"], number]> = [
  ["minute", 60_000],
  ["hour", 3_600_000],
  ["day", 86_400_000],
  ["week", 7 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["year", 365 * 86_400_000],
];

/**
 * 侧边栏窄列用的紧凑相对时间（"3m"、"2h"、"3天"），一分钟内显示"现在"。
 * @param date 要格式化的时间
 * @param locale 当前语言
 * @param now 用于测试或特殊场景的当前时间
 * @returns 不带"前"的短文本；无效时间返回空串
 */
export function formatCompactRelativeTime(date: Date | string, locale: Locale, now = new Date()): string {
  const target = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(target.getTime())) return "";
  const ageMs = Math.max(0, now.getTime() - target.getTime());
  if (ageMs < 60_000) {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" }).format(0, "second");
  }
  let index = 0;
  while (index + 1 < COMPACT_UNITS.length && ageMs >= COMPACT_UNITS[index + 1][1]) index++;
  const [unit, size] = COMPACT_UNITS[index];
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow" }).format(Math.floor(ageMs / size));
}

/**
 * 日期时间 → 跟随**应用语言**（而不是操作系统 locale）的本地化文本（数据/测试审计 A-9）。
 *
 * 为什么需要：调用点各自写的 `toLocaleString(undefined, …)` 跟随操作系统，与同一张卡片里
 * 跟随应用语言的 `formatUpdatedTime` 不一致。统一走这个助手（显式传 locale）。
 *
 * @param value Date、毫秒时间戳或 ISO 字符串
 * @param locale 应用语言
 * @param options 传给 Intl.DateTimeFormat 的选项（缺省：date + time，short）
 * @returns 本地化文本；无效时间返回空串
 */
export function formatDateTime(
  value: Date | string | number,
  locale: Locale,
  options: Intl.DateTimeFormatOptions = { dateStyle: "short", timeStyle: "short" },
): string {
  const target = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(target.getTime())) return "";
  return new Intl.DateTimeFormat(locale, options).format(target);
}

/**
 * 时刻 → 跟随应用语言的 HH:MM（`formatUpdatedTime` 的显式 locale 版本，
 * 供需要固定时刻而非相对时间的卡片使用）。无效时间返回空串。
 */
export function formatClockTime(value: Date | string | number, locale: Locale): string {
  return formatDateTime(value, locale, { hour: "2-digit", minute: "2-digit" });
}

const SHORT_TIME_UNITS: Record<Locale, { now: string; minute: string; hour: string; day: string; week: string; month: string; year: string }> = {
  en: { now: "now", minute: "m", hour: "h", day: "d", week: "w", month: "mo", year: "y" },
  "zh-CN": { now: "刚刚", minute: "分", hour: "小时", day: "天", week: "周", month: "个月", year: "年" },
  "zh-TW": { now: "剛剛", minute: "分", hour: "小時", day: "天", week: "週", month: "個月", year: "年" },
};

/**
 * 侧边栏右侧一列使用的紧凑相对时间（"5m"、"3小时"）。
 * @param date 要格式化的时间
 * @param locale 当前语言（未知语言按英语）
 * @param now 用于测试或特殊场景的当前时间
 * @returns 紧凑的相对时间文本；未来时间按“刚刚”，无效时间为空字符串
 */
export function formatShortRelativeTime(date: Date | string, locale: Locale, now = new Date()): string {
  const target = date instanceof Date ? date : new Date(date);
  const elapsedMs = now.getTime() - target.getTime();
  if (Number.isNaN(elapsedMs)) return "";
  const units = Object.hasOwn(SHORT_TIME_UNITS, locale) ? SHORT_TIME_UNITS[locale] : SHORT_TIME_UNITS.en;
  const elapsed = Math.max(0, elapsedMs);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return units.now;
  if (minutes < 60) return `${minutes}${units.minute}`;
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours < 24) return `${hours}${units.hour}`;
  const days = Math.floor(elapsed / 86_400_000);
  if (days < 7) return `${days}${units.day}`;
  if (days < 30) return `${Math.floor(days / 7)}${units.week}`;
  if (days < 365) return `${Math.max(1, Math.floor(days / 30))}${units.month}`;
  return `${Math.floor(days / 365)}${units.year}`;
}
