"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TeamWorkbenchSnapshot } from "@/lib/agent-teams-swimlane";
import {
  FORMATION_BOTTOM,
  FORMATION_TITLE_X,
  FORMATION_TITLE_Y,
  LEAD_FOOT,
  LEAD_BUS_Y,
  MEMBER_FOOT,
  MEMBER_PITCH,
  MEMBER_SLOT_WIDTH,
  MEMBER_TOP,
  PEER_BUS_Y,
  layoutFormation,
  sortWorkersByUrgency,
  type FormationMember,
  type MemberWorkState,
} from "@/lib/agent-teams-formation-layout";
import type { TicketUrgency } from "@/lib/agent-teams-task-layout";

const ACCENTS = new Set(["blue", "green", "purple", "orange", "teal", "pink", "red", "gray"]);

/** 调色板名 → 强调色 class（真实取值在 native-theme.css 的 --formation-accent）。 */
function accentClass(accent: string): string {
  return `agent-teams-formation-accent--${ACCENTS.has(accent) ? accent : "gray"}`;
}

/** 成员工作态 → i18n key（动态键）。 */
function workStateKey(state: MemberWorkState): string {
  return `teams.memberState.${state}`;
}

/** 角色（agentType）→ 本地化词条键；无词条回退原文，绝不把 key 渲染到界面。 */
function roleLabel(role: string, t: (key: string) => string): string {
  const key = `teams.role.${role}`;
  const label = t(key);
  return label === key ? role : label;
}

/** 最紧急票态的徽标文案：failed 用独立 key，其余复用统计头已有的 key。 */
function urgencyLabelKey(urgency: TicketUrgency): string {
  return urgency === "failed" ? "teams.urgency.failed" : `teams.stats.${urgency}`;
}

function ModelChip({ model }: { model: string | null }) {
  if (!model) return null;
  return <span className="agent-teams-formation-model" title={model}>{model}</span>;
}

function ProgressBar({ node }: { node: FormationMember }) {
  if (node.total === 0) return null;
  return (
    <span
      className="agent-teams-formation-progress"
      role="img"
      aria-label={`${node.completed}/${node.total}`}
    >
      {node.segments.map((segment) => (
        <span
          key={segment.urgency}
          className={`agent-teams-formation-seg agent-teams-formation-seg--${segment.urgency}`}
          style={{ flexGrow: segment.count }}
          data-segment={segment.urgency}
          data-count={segment.count}
        />
      ))}
    </span>
  );
}

function MemberCard({ node, onSelect }: { node: FormationMember; onSelect: (member: FormationMember) => void }) {
  const { t } = useI18n();
  const { member, isLead } = node;
  const stateLabel = t(workStateKey(node.workState));
  return (
    <article
      className={`agent-teams-formation-card ${isLead ? "agent-teams-formation-card--lead" : ""} ${accentClass(node.accent)}`}
      style={{ left: node.centerX - MEMBER_SLOT_WIDTH / 2, top: node.top, width: MEMBER_SLOT_WIDTH }}
      data-member-id={member.id}
      data-member-state={node.workState}
      data-urgency={node.urgency ?? undefined}
    >
      <button
        type="button"
        className="agent-teams-formation-hit"
        onClick={() => onSelect(node)}
        aria-label={`${member.name} · ${stateLabel}`}
      >
        <span className="agent-teams-formation-avatar" aria-hidden="true">{member.name.slice(0, 1)}</span>
        <span className="agent-teams-formation-identity">
          <span className="agent-teams-formation-role">{roleLabel(member.role, t)}</span>
          <span className="agent-teams-formation-name">{member.name}</span>
          {isLead && <span className="agent-teams-formation-lead-tag">{t("teams.leader")}</span>}
          <ModelChip model={member.model} />
        </span>
        <span className={`agent-teams-formation-state agent-teams-formation-state--${node.workState}`}>
          <span className="agent-teams-formation-state-dot" aria-hidden="true" />
          <span className="agent-teams-formation-state-label">{stateLabel}</span>
        </span>
        {!isLead && <ProgressBar node={node} />}
        {node.urgency && (
          <span className={`agent-teams-formation-badge agent-teams-formation-badge--${node.urgency}`}>
            {t(urgencyLabelKey(node.urgency))}
          </span>
        )}
      </button>
    </article>
  );
}

interface Props {
  snapshot: TeamWorkbenchSnapshot;
  /** 画布宽度（与任务画布共用）；成员行据此居中。 */
  width: number;
  /** 点击成员卡（可选）：上层用它打开该成员会话。 */
  onSelectMember?: (memberId: string, sessionId: string | null) => void;
}

/**
 * 编队带（画布上半，y ∈ [0, 410]）：队长置顶居中、成员排下方，中间夹 lead bus 与
 * peer bus，填掉任务泳道上方的空白区（见 lib/agent-teams-formation-layout.ts）。
 * 成员默认按加入顺序（稳定不重排），可切换「按紧急度重排」；紧急度变化只改徽标。
 */
export function FormationBand({ snapshot, width, onSelectMember }: Props) {
  const { t } = useI18n();
  const layout = useMemo(() => layoutFormation(snapshot, width), [snapshot, width]);
  const [sortMode, setSortMode] = useState<"joined" | "urgency">("joined");

  const orderedWorkers = useMemo(() => {
    if (sortMode === "joined") return layout.workers;
    const sorted = sortWorkersByUrgency(layout.workers);
    const startX = layout.bus.firstWorkerX ?? 0;
    return sorted.map((node, index) => ({ ...node, centerX: startX + index * MEMBER_PITCH }));
  }, [layout, sortMode]);

  const handleSelect = (node: FormationMember) => {
    onSelectMember?.(node.member.id, node.member.sessionId);
  };

  const { lead, bus } = layout;
  const hasWorkers = orderedWorkers.length > 0;

  return (
    <div
      className="agent-teams-formation"
      style={{ width, height: FORMATION_BOTTOM }}
      data-testid="agent-teams-formation"
    >
      <span className="agent-teams-formation-title" style={{ left: FORMATION_TITLE_X, top: FORMATION_TITLE_Y }}>
        {t("teams.formation.title")}
      </span>
      {orderedWorkers.length > 1 && (
        <button
          type="button"
          className="agent-teams-formation-sort"
          aria-pressed={sortMode === "urgency"}
          onClick={() => setSortMode((mode) => (mode === "joined" ? "urgency" : "joined"))}
        >
          {t("teams.formation.sortByUrgency")}
        </button>
      )}

      <svg className="agent-teams-formation-buses" width={width} height={FORMATION_BOTTOM} aria-hidden="true">
        {lead && hasWorkers && bus.leadX !== null && (
          <g data-channel="lead">
            <path className="agent-teams-formation-bus" d={`M ${bus.leadX} ${LEAD_FOOT} L ${bus.leadX} ${LEAD_BUS_Y}`} />
            <path
              className="agent-teams-formation-bus"
              d={`M ${bus.firstWorkerX} ${LEAD_BUS_Y} L ${bus.lastWorkerX} ${LEAD_BUS_Y}`}
            />
            {orderedWorkers.map((node) => (
              <path
                key={node.member.id}
                className="agent-teams-formation-bus"
                d={`M ${node.centerX} ${LEAD_BUS_Y} L ${node.centerX} ${MEMBER_TOP}`}
              />
            ))}
          </g>
        )}
        {orderedWorkers.length === 1 && bus.firstWorkerX !== null && (
          <path
            className="agent-teams-formation-bus"
            d={`M ${bus.firstWorkerX} ${MEMBER_FOOT} L ${bus.firstWorkerX} ${PEER_BUS_Y}`}
          />
        )}
        {orderedWorkers.length > 1 && bus.firstWorkerX !== null && bus.lastWorkerX !== null && (
          <g data-channel="peer">
            <path
              className="agent-teams-formation-bus"
              d={`M ${bus.firstWorkerX} ${MEMBER_FOOT} L ${bus.firstWorkerX} ${PEER_BUS_Y} L ${bus.lastWorkerX} ${PEER_BUS_Y} L ${bus.lastWorkerX} ${MEMBER_FOOT}`}
            />
            {orderedWorkers.slice(1, -1).map((node) => (
              <path
                key={node.member.id}
                className="agent-teams-formation-bus"
                d={`M ${node.centerX} ${MEMBER_FOOT} L ${node.centerX} ${PEER_BUS_Y}`}
              />
            ))}
          </g>
        )}
      </svg>

      {lead && <MemberCard node={lead} onSelect={handleSelect} />}
      {orderedWorkers.map((node) => (
        <MemberCard key={node.member.id} node={node} onSelect={handleSelect} />
      ))}
    </div>
  );
}
