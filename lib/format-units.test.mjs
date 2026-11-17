import assert from "node:assert/strict";
import test from "node:test";
import { formatBytes, formatDurationHuman, formatElapsedClock } from "./format-units.ts";

// A-10：统一字节/时长口径。调用点替换后，同一数值在所有面板应显示一致。

test("formatBytes：1024 进制，≥1 KB 保留 1 位小数（500000 → 488.3 KB）", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(-5), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(500_000), "488.3 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(1024 * 1024 * 1024), "1.0 GB");
  assert.equal(formatBytes(Number.NaN), "0 B");
});

test("formatElapsedClock：MM:SS 或 HH:MM:SS，负值夹到 0", () => {
  assert.equal(formatElapsedClock(0), "00:00");
  assert.equal(formatElapsedClock(65_000), "01:05");
  assert.equal(formatElapsedClock(3_725_000), "01:02:05");
  assert.equal(formatElapsedClock(-1000), "00:00");
  assert.equal(formatElapsedClock(Number.NaN), "00:00");
});

test("formatDurationHuman：ms / s / m / h / d 分档", () => {
  assert.equal(formatDurationHuman(850), "850 ms");
  assert.equal(formatDurationHuman(1200), "1.2 s");
  assert.equal(formatDurationHuman(125_000), "2m 5s");
  assert.equal(formatDurationHuman(3_900_000), "1h 5m");
  assert.equal(formatDurationHuman(2 * 86_400_000 + 3 * 3_600_000), "2d 3h");
  assert.equal(formatDurationHuman(null), null);
  assert.equal(formatDurationHuman(-1), null);
  assert.equal(formatDurationHuman(Number.NaN), null);
});
