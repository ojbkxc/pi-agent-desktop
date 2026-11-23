/**
 * 破甲控制台的「试跑」：把一段样例文本按当前（或草稿）设置过一遍，返回改写前后。
 *
 * 为什么要有它：改写规则、同义词、前缀剥离、技能注入、结构化后缀这些开关，光看开关
 * 名字根本推不出「我的请求到底会变成什么样」。以前只能保存 → 发一轮 → 回头看，
 * 而保存是**全局生效**的：调错一次，会话里每条请求都被改。试跑让「先看结果再保存」
 * 成为可能，且完全不写盘、不碰真实会话。
 *
 * 边界：这是**预览**，不是第二条数据面。真正的治理仍只在 `lib/purge/extension.ts`
 * 的 `before_agent_start` / `context` 里发生；这里调用的是同一批纯函数
 * （`governSystemText` / `governUserText` / `resolveAutoPreset`），所以「预览说会改成
 * 什么」与「实际会改成什么」共用一份实现，不会分叉。
 */

import { resolveAutoPreset } from "./auto-apply";
import { governSystemText, governUserText } from "./governance";
import { BUILTIN_PRESETS } from "./preset-catalog";
import type { PurgeSettings } from "./types";

/** 一次试跑请求带哪一侧的文本。`system` 只跑宿主提示词那一半治理。 */
export type PurgePreviewKind = "user" | "system";

export interface PurgePreviewInput {
  text: string;
  kind: PurgePreviewKind;
  /** 草稿设置；省略时用已保存的设置（由路由注入）。 */
  settings: PurgeSettings;
  /** 当前模型标识，只影响「自动套用会挑哪条」，不影响任何改写。 */
  model?: string;
}

export interface PurgePreviewResult {
  kind: PurgePreviewKind;
  /** 总闸关着：逐字节透传，下面的 hits 全为 0。 */
  passthrough: boolean;
  input: string;
  output: string;
  /** 长度差（码点），面板用来标「+37 / −12」。 */
  deltaChars: number;
  rewrite_hits: number;
  synonym_hits: number;
  skill_hits: number;
  structured: boolean;
  /**
   * 自动套用命中的预设摘要。`system` 侧才会套，`user` 侧恒为 null —— 与数据面
   * 一致：预设正文拼在系统提示词上，不拼在用户消息里。
   */
  auto_preset: { id: string; title: string; match: string } | null;
  /** 试跑第二个「如果」：把草稿设成关掉总闸会得到什么（逐字节 = 输入）。 */
  passthrough_output: string;
}

/** 码点长度，不是 UTF-16 长度：emoji/CJK 的差值与用户看到的字数一致。 */
function charCount(text: string): number {
  return Array.from(text).length;
}

/**
 * 跑一次试跑。纯函数：不读盘、不联网、不写设置。
 *
 * 空文本仍然返回结构完整的记录（output 为空）：面板在空输入时不该渲染成「出错了」。
 */
export function previewGovernance(input: PurgePreviewInput): PurgePreviewResult {
  const text = typeof input.text === "string" ? input.text : "";
  const settings = input.settings;
  const passthrough = !settings || settings.enabled !== true;

  if (input.kind === "system") {
    const governed = passthrough
      ? { text, rewrite_hits: 0, synonym_hits: 0, skill_hits: 0 }
      : governSystemText(text, settings);
    let output = governed.text;
    let auto: PurgePreviewResult["auto_preset"] = null;
    if (!passthrough && settings.auto_preset) {
      const model = typeof input.model === "string" ? input.model : "";
      const hit = resolveAutoPreset(BUILTIN_PRESETS, settings, model);
      if (hit) {
        auto = { id: hit.preset.id, title: hit.preset.title, match: hit.match };
        // 与 extension.ts 的拼接口径一致：宿主提示词里已含这段正文时不再重复拼。
        if (!output.includes(hit.preset.body)) {
          output = settings.auto_preset_mode === "append"
            ? `${output}\n\n${hit.preset.body}`
            : `${hit.preset.body}\n\n${output}`;
        }
      }
    }
    return {
      kind: "system",
      passthrough,
      input: text,
      output,
      deltaChars: charCount(output) - charCount(text),
      rewrite_hits: governed.rewrite_hits,
      synonym_hits: governed.synonym_hits,
      skill_hits: 0,
      structured: false,
      auto_preset: auto,
      passthrough_output: text,
    };
  }

  const governed = passthrough
    ? { text, rewrite_hits: 0, synonym_hits: 0, skill_hits: 0, structured: false }
    : governUserText(text, settings);
  return {
    kind: "user",
    passthrough,
    input: text,
    output: governed.text,
    deltaChars: charCount(governed.text) - charCount(text),
    rewrite_hits: governed.rewrite_hits,
    synonym_hits: governed.synonym_hits,
    skill_hits: governed.skill_hits,
    structured: governed.structured,
    auto_preset: null,
    passthrough_output: text,
  };
}

/** 试跑文本上限：面板里的一段样例，不是整份会话。 */
export const PURGE_PREVIEW_MAX_CHARS = 20_000;

/** 判一次请求的 `kind`。未知值一律当 `user`（更常见的那个）。 */
export function asPurgePreviewKind(raw: unknown): PurgePreviewKind {
  return raw === "system" ? "system" : "user";
}