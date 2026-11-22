/**
 * 三个纯字符串小工具，先前在多个文件里各抄一份。
 *
 * - `safeDecode`：`decodeURIComponent` 的容错版（坏转义原样返回）。
 * - `escapeRegExp`：把正则元字符转义，让 needle 只做字面量匹配。
 * - `cleanString`：未知值 → 去空白后的非空字符串，否则 undefined。
 *
 * 无依赖、无 I/O：客户端与服务端都可 import。
 */

/** `decodeURIComponent` 的容错版：非法转义序列原样返回。 */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 转义正则元字符，使结果只能字面量匹配。 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 未知值 → trim 后的非空字符串；其余一律 undefined。 */
export function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
