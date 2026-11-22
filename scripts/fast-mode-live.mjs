/**
 * `--live`: is fast mode actually running on this machine?
 *
 * A green suite cannot answer that. The settings file only says what *would* be
 * sent next; a `pi-web:fast-mode` entry in a session transcript is the only proof
 * the extension ever ran — and a freshly written extension runs only after the
 * process that loads it restarts.
 *
 * Kept out of `check-fast-mode.mjs` (which has a CLI main) so tests can import it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function liveReport(env = process.env) {
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const settingsPath = join(agentDir, "pi-web", "settings.json");
  // The effective preset must mean what the runtime means: a stored value the runtime
  // would reject reads as "off" here too, or the report and the prompt disagree.
  const KNOWN = ["off", "conservative", "standard"];
  let storedPreset = null;
  let preset = "off";
  let note = "";
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, ""));
    storedPreset = parsed?.fastMode?.preset ?? null;
    if (typeof storedPreset !== "string") note = "(not set, defaults to off)";
    else if (!KNOWN.includes(storedPreset)) note = `(stored "${storedPreset}" is not a preset; runtime uses off)`;
    else preset = storedPreset;
  } catch (error) {
    preset = "off";
    note = `(unreadable: ${error instanceof Error ? error.message : String(error)}; runtime uses off)`;
  }
  const sessionsDir = join(agentDir, "sessions");
  let entries = 0;
  let lastSession = null;
  let lastModified = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      const text = readFileSync(path, "utf8");
      entries += text.split("pi-web:fast-mode").length - 1;
      const modified = statSync(path).mtimeMs;
      if (modified > lastModified) {
        lastModified = modified;
        lastSession = path;
      }
    }
  };
  if (existsSync(sessionsDir)) walk(sessionsDir);

  // The transcript records system messages, so the section itself is observable: a run
  // that carried it leaves "Speed rules for this session" (or a <fast_mode> tag) behind.
  // "Ran" and "the section actually reached the request" are different claims.
  let promptSeen = false;
  if (lastSession) {
    try {
      promptSeen = /Speed rules for this session|<fast_mode>/.test(readFileSync(lastSession, "utf8"));
    } catch {
      promptSeen = false;
    }
  }

  // One list, in troubleshooting order: fix the first layer that is not ok, not the last
  // one that looks wrong. Every later layer depends on the earlier ones.
  const layers = [
    {
      name: "configure",
      ok: preset !== "off" && !note.includes("unreadable") && !note.includes("not a preset"),
      detail: note || preset,
    },
    { name: "run", ok: entries > 0, detail: `${entries} 条目` },
    { name: "prompt", ok: promptSeen, detail: promptSeen ? "段落可见" : "未见段落" },
  ];
  const firstBroken = layers.find((layer) => !layer.ok);
  return {
    agentDir,
    preset,
    storedPreset,
    note,
    entries,
    lastSession,
    lastSessionAt: lastSession ? new Date(lastModified).toISOString() : null,
    promptSeen,
    layers,
    status: firstBroken
      ? `未全绿：先修第 ${layers.indexOf(firstBroken) + 1} 层（${firstBroken.name}）`
      : "全绿：配置、执行、段落都在",
    verdict: entries > 0
      ? promptSeen
        ? "已在使用：最近会话里能看到 fast_mode 段落"
        : "跑过，但最近会话里没看到段落（可能是开关刚关掉，或那是旧会话）"
      : "尚无使用证据：没有会话写出过 pi-web:fast-mode 条目（多半是宿主进程还没重启加载这段代码）",
    steps: entries > 0
      ? []
      : [
          "1. 重启正在用的 pi-web 进程（或用它启动 `npm run dev`）——写入的代码不会自行生效",
          "2. 在该应用里发一轮对话（任意一句话，让 before_agent_start 跑一次）",
          "3. 重新执行 `node scripts/check-fast-mode.mjs --live`，条目数应从 0 变成 ≥1",
        ],
  };
}