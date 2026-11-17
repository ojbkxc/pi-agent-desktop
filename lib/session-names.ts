/**
 * 会话名（标题）的共享上限。
 *
 * 服务端 `PATCH /api/sessions/[id]` 与侧栏重命名输入框必须用同一个数字，
 * 否则一侧允许写入、另一侧静默截断，用户会看到「名字没保存全」。
 * 数据/测试审计 A-7：服务端此前对 `name` 无长度上限（可写入任意长标题，
 * 撑大 session_info 条目与侧栏渲染）。
 */
export const SESSION_NAME_MAX_LENGTH = 200;

/**
 * 规整一个会话名：去首尾空白，并按码点（而非 UTF-16 code unit）截断到上限，
 * 避免把代理对（emoji 等）从中间切开。空串表示「清除标题」，原样返回。
 */
export function normalizeSessionName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= SESSION_NAME_MAX_LENGTH) return trimmed;
  // Array.from 按码点切分；中文/emoji 都安全。
  return Array.from(trimmed).slice(0, SESSION_NAME_MAX_LENGTH).join("");
}
