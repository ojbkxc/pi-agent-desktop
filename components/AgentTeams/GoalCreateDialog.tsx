"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  GOAL_MAX_REPEAT_MS,
  GOAL_REPEAT_PRESETS,
  formatGoalInterval,
  parseGoalRepeat,
} from "@/lib/goal/goal-interval";

/**
 * 「新建目标」弹窗，形态对齐 Alma 的那个 goal 面板：
 *
 * ```
 * 持续工作直到满足条件
 *   [ npm test exits 0 and lint is clean ]
 *   Checked after every turn by a separate model. Name evidence it can see in the conversation.
 *
 * 按计划重复
 *   [ 不停迭代该项目 ]
 *   Lead with an interval — 5m, 2h, 1d. Stops after 7 days.
 *
 *                                        Cancel    Start
 * ```
 *
 * 两个框都是「自由文本」，间隔写在第二框**开头**（`2h 不停迭代该项目`）；不写间隔 =
 * 连续续跑。Start 在两框都空时置灰（与 Alma 一致：什么都不给就没东西可跑）。
 *
 * **本组件不写盘、不调接口**：确认后只把参数拼成一条 `/goal …` 文本，交给 composer 的
 * 发送链路 —— 目标的唯一真源始终是扩展（桌面自己写盘会与它的状态机分叉）。
 */
export interface GoalCreateDialogProps {
  open: boolean;
  /** 用户确认：返回要发送的 `/goal …` 命令文本。 */
  onSubmit(command: string): void;
  onCancel(): void;
}

/** 把两栏内容拼成 `/goal` 命令。目标正文取条件栏（Alma 里那一栏才是「要做的事」）。 */
export function buildGoalCommand(input: { condition: string; repeat: string }): string {
  const condition = input.condition.trim();
  const repeat = input.repeat.trim();
  const parsed = parseGoalRepeat(repeat);
  const parts = ["/goal"];
  if (condition) parts.push(condition);
  if (parsed.intervalMs > 0) parts.push("--every", formatGoalInterval(parsed.intervalMs));
  // 间隔之外的说明（如「不停迭代该项目」）没有语义，只作备注 —— 不塞进命令，避免
  // 让它变成目标正文的一部分。
  return parts.join(" ");
}

export function GoalCreateDialog({ open, onSubmit, onCancel }: GoalCreateDialogProps) {
  const { t } = useI18n();
  const [condition, setCondition] = useState("");
  const [repeat, setRepeat] = useState("");

  // 每次打开都从默认值开始：「按计划重复」预填「不停迭代该项目」（Alma 的默认文案）。
  useEffect(() => {
    if (!open) return;
    setCondition("");
    setRepeat(t("goal.dialog.repeatDefault"));
  }, [open, t]);

  const parsed = useMemo(() => parseGoalRepeat(repeat), [repeat]);
  const canStart = condition.trim().length > 0 || parsed.intervalMs > 0;

  if (!open) return null;

  const submit = () => {
    if (!canStart) return;
    onSubmit(buildGoalCommand({ condition, repeat }));
  };

  return (
    <div
      className="goal-dialog-backdrop"
      role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); onCancel(); }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
      }}
    >
      <div className="goal-dialog" role="dialog" aria-modal="true" aria-label={t("goal.dialog.title")}>
        <h3 className="goal-dialog-title">{t("goal.dialog.title")}</h3>

        <label className="goal-dialog-label" htmlFor="goal-dialog-condition">
          {t("goal.dialog.conditionLabel")}
        </label>
        <textarea
          id="goal-dialog-condition"
          className="goal-dialog-input goal-dialog-textarea"
          value={condition}
          autoFocus
          rows={2}
          placeholder={t("goal.dialog.conditionPlaceholder")}
          onChange={(event) => setCondition(event.target.value)}
        />
        <p className="goal-dialog-hint">{t("goal.dialog.conditionHint")}</p>

        <label className="goal-dialog-label" htmlFor="goal-dialog-repeat">
          {t("goal.dialog.repeatLabel")}
        </label>
        <input
          id="goal-dialog-repeat"
          className="goal-dialog-input"
          value={repeat}
          placeholder={t("goal.dialog.repeatPlaceholder")}
          onChange={(event) => setRepeat(event.target.value)}
        />
        <p className={`goal-dialog-hint${parsed.invalid ? " is-warning" : ""}`}>
          {parsed.invalid
            ? t("goal.dialog.repeatInvalid", { value: `${Math.round(GOAL_MAX_REPEAT_MS / 86_400_000)}d` })
            : t("goal.dialog.repeatHint")}
        </p>

        <div className="goal-dialog-presets">
          {GOAL_REPEAT_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              className={`goal-dialog-preset${parsed.intervalMs === parseGoalRepeat(preset.value).intervalMs && parsed.intervalMs > 0 ? " is-active" : ""}`}
              onClick={() => setRepeat(`${preset.value} ${t("goal.dialog.repeatDefault")}`)}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="goal-dialog-actions">
          <button type="button" className="goal-dialog-cancel" onClick={onCancel}>
            {t("i18n.cancel")}
          </button>
          <button
            type="button"
            className="goal-dialog-start native-primary-button"
            disabled={!canStart}
            onClick={submit}
          >
            {t("goal.dialog.start")}
          </button>
        </div>
      </div>
    </div>
  );
}