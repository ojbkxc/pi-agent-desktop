/**
 * 字节 / 时长的单一格式化口径（数据/测试审计 A-10）。
 *
 * 背景：仓库里同一数值有 4 套字节口径（十进制 500 KB / 1024 进制 488.3 KB /
 * 四舍五入 488 KB）和 4 套时长口径，同一个文件在不同面板显示不同数字。
 * 这里给出唯一实现；调用点按清单替换（components/** 由各自 owner 改）。
 *
 * 口径选择（与仓库多数实现一致）：
 * - 字节：1024 进制（二进制 KB/MB/GB），≥1 KB 保留 1 位小数，<1 KB 显示整数 B。
 *   这也是 FileViewer / DesktopAppSection / chat-attachments 现有写法，改动面最小。
 * - 时钟时长：`formatElapsedClock` → HH:MM:SS（>1h）或 MM:SS，用于媒体时长/已用时间。
 * - 人类可读时长：`formatDurationHuman` → "850 ms" / "1.2 s" / "2m 5s" / "1h 5m" / "2d 3h"。
 */

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

/**
 * 字节数 → "488.3 KB"。非有限或负数按 0 处理。
 * 例：500000 → "488.3 KB"；1024 → "1.0 KB"；512 → "512 B"。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < KIB) return `${Math.round(bytes)} B`;
  if (bytes < MIB) return `${(bytes / KIB).toFixed(1)} KB`;
  if (bytes < GIB) return `${(bytes / MIB).toFixed(1)} MB`;
  return `${(bytes / GIB).toFixed(1)} GB`;
}

/**
 * 毫秒 → 时钟样式 "MM:SS"（不足 1 小时）或 "HH:MM:SS"。负值夹到 0。
 * 例：65000 → "01:05"；3725000 → "01:02:05"。
 */
export function formatElapsedClock(valueMs: number): string {
  const seconds = Math.max(0, Math.round((Number.isFinite(valueMs) ? valueMs : 0) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (part: number) => String(part).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

/**
 * 毫秒 → 人类可读时长："850 ms" / "1.2 s" / "2m 5s" / "1h 5m" / "2d 3h"。
 * null / 非有限 / 负数返回 null（调用点据此不渲染）。
 */
export function formatDurationHuman(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
