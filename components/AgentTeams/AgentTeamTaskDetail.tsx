"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { getTicketUrgency, type TicketUrgency } from "@/lib/agent-teams-task-layout";
import { resolveTicketOwner } from "@/lib/agent-teams-owner";
import type { TeamWorkbenchSnapshot } from "@/lib/agent-teams-swimlane";

/** 票态（紧急度）→ 复用既有词条键（与成员检查器同一口径）。 */
function ticketStateLabelKey(urgency: TicketUrgency): string {
  if (urgency === "completed") return "teams.status.completed";
  if (urgency === "running") return "teams.status.running";
  if (urgency === "failed") return "teams.status.failed";
  if (urgency === "blocked") return "teams.stats.blocked";
  return "teams.stats.available";
}

/** 抽屉切换到「低位全宽」形态的视口宽度门槛（与 useIsMobile / globals.css 同值）。 */
export const TASK_DETAIL_NARROW_BREAKPOINT = 640;
/** 宽屏抽屉宽度。 */
export const TASK_DETAIL_WIDTH = 360;

/**
 * 抽屉右偏移的夹取（纯函数，便于单测；css.md P2 #7）：
 * 抽屉宽 360，左边缘至少留 8px ⇒ right ≤ 视口 − 368。原实现的偏移量完全不夹——
 * 375×667 下 left ≈ −52px（标题与 ✕ 出屏），通信栏打开时 right:396 直接把抽屉
 * 推到屏幕外；768 宽 + dockOpen 只剩 12px，700 宽已为负。
 */
export function clampTaskDetailRight(dockOpen: boolean, viewportWidth: number): number {
  // 左边缘至少留 8px：right ≤ 视口 − (抽屉宽 + 8)。
  return Math.max(8, Math.min(dockOpen ? 396 : 68, viewportWidth - TASK_DETAIL_WIDTH - 8));
}

/**
 * 抽屉几何：窄视口走左右各 8、底部 8 的全宽低位抽屉（窄屏上不再让位于右侧通信栏，
 * 抽屉本身是全宽浮层）；宽视口维持右下角形态，但右偏移按视口夹取。
 */
export function taskDetailDrawerGeometry(
  narrow: boolean,
  dockOpen: boolean,
  viewportWidth: number,
): { left: number | "auto"; right: number | "auto"; bottom: number; width: number | "auto"; maxWidth: string } {
  if (narrow || viewportWidth <= TASK_DETAIL_NARROW_BREAKPOINT) {
    return { left: 8, right: 8, bottom: 8, width: "auto", maxWidth: "none" };
  }
  return {
    left: "auto",
    right: clampTaskDetailRight(dockOpen, viewportWidth),
    bottom: 16,
    width: TASK_DETAIL_WIDTH,
    maxWidth: "min(360px, calc(100vw - 16px))",
  };
}

export interface AgentTeamTaskDetailProps {
  snapshot: TeamWorkbenchSnapshot;
  /** 被选中的票 id；票已从快照消失时本组件返回 null。 */
  ticketId: string;
  /** 关闭抽屉。 */
  onClose: () => void;
  /** 点负责人 → 打开该成员检查器（可选）。 */
  onSelectMember?: (memberId: string) => void;
  /** 点依赖 / 解锁里的票 id → 切到那张票的详情（可选；缺省时按钮禁用）。 */
  onSelectTicket?: (ticketId: string) => void;
  /** 右列是否展开（决定抽屉的右偏移，避免压住右列）。 */
  dockOpen?: boolean;
}

/**
 * 任务详情抽屉的**内容**（非门户）：纯展示，数据全部来自当前快照；关闭由上层把
 * selectedTicketId 置空。抽出来是为了能在无 DOM 的 SSR 测试里直接渲染并断言
 * 内容与几何（门户包装 `AgentTeamTaskDetail` 依赖 `document`，SSR 渲不出任何东西）。
 */
export function AgentTeamTaskDetailBody({
  snapshot,
  ticketId,
  onClose,
  onSelectMember,
  onSelectTicket,
  dockOpen = false,
}: AgentTeamTaskDetailProps) {
  const { t } = useI18n();
  const asideRef = useRef<HTMLElement>(null);
  // 窄屏形态由共享断点 hook 提供（SSR 首帧按宽屏渲染，portal 挂载后才出现）。
  const narrow = useIsMobile();
  // 非模态抽屉的焦点归还（a11y.md P2）：打开前谁有焦点（任务卡），关闭后若焦点
  // 仍在抽屉内或已掉到 body 就还给它。与 focusModalPanel 的归还条件同一口径：
  // 用户中途把焦点移到别处就不抢。
  const openerRef = useRef<HTMLElement | null>(null);

  // 打开即聚焦（键盘可达）：抽屉非模态，只需把焦点落到本面板，Esc 即可关闭。
  useEffect(() => {
    openerRef.current = (typeof document === "undefined"
      ? null
      : document.activeElement as HTMLElement | null);
    asideRef.current?.focus({ preventScroll: true });
    return () => {
      const opener = openerRef.current;
      if (!opener || !opener.isConnected) return;
      const active = typeof document === "undefined" ? null : document.activeElement;
      const stillOurs = active === null || active === document.body
        || Boolean(asideRef.current && asideRef.current.contains(active));
      if (stillOurs) opener.focus({ preventScroll: true });
    };
  }, []);

  const ticket = useMemo(
    () => snapshot.tickets.find((candidate) => candidate.id === ticketId) ?? null,
    [snapshot.tickets, ticketId],
  );
  const ticketsById = useMemo(() => new Map(snapshot.tickets.map((item) => [item.id, item])), [snapshot.tickets]);
  // 负责人解析：显式 ownerId 优先；缺失时从 assignments / 派工消息回填并标记 inferred。
  const ownerResolution = useMemo(
    () => (ticket ? resolveTicketOwner(ticket, snapshot.members, snapshot.messages) : null),
    [snapshot.members, snapshot.messages, ticket],
  );
  // 负责人成员（用于状态与「打开成员」）；回填得到的 id 同样能解析到成员。
  const owner = useMemo(
    () => (ownerResolution?.memberId
      ? snapshot.members.find((member) => member.id === ownerResolution.memberId) ?? null
      : null),
    [snapshot.members, ownerResolution],
  );
  // 负责人自身已停止/失败：票没人推进，抽屉要提示「负责人未在工作」。
  const ownerStalled = Boolean(
    owner && (owner.status === "failed" || owner.status === "parked" || owner.status === "aborted"),
  );
  // 解锁：依赖本票的其它票（谁的 dependencies 含本票 id）。
  const unblocks = useMemo(
    () => snapshot.tickets.filter((candidate) => candidate.dependencies.includes(ticketId)).map((candidate) => candidate.id),
    [snapshot.tickets, ticketId],
  );

  if (!ticket) return null;

  const urgency = getTicketUrgency(ticket, ticketsById);
  const deps = ticket.dependencies;

  const chip = (label: string, ids: string[]) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
      <span className="agent-teams-member-role">{label}:</span>
      {ids.length > 0 ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          {ids.map((id) => (
            <button
              key={id}
              type="button"
              data-jump-ticket={id}
              onClick={() => onSelectTicket?.(id)}
              disabled={!onSelectTicket}
              aria-label={t("teams.task.jumpTo", { ticket: `#${id}` })}
              style={{
                border: "none",
                background: "none",
                padding: 0,
                fontFamily: "var(--font-mono)",
                color: onSelectTicket ? "var(--accent)" : "var(--text-muted)",
                cursor: onSelectTicket ? "pointer" : "default",
                font: "inherit",
              }}
            >
              #{id}
            </button>
          ))}
        </span>
      ) : (
        <span style={{ fontFamily: "var(--font-mono)" }}>—</span>
      )}
    </span>
  );

  const geometry = taskDetailDrawerGeometry(
    narrow,
    dockOpen,
    typeof window === "undefined" ? 1024 : window.innerWidth,
  );

  return (
    <aside
      ref={asideRef}
      className="agent-teams-task-detail"
      data-testid="agent-teams-task-detail"
      data-task-id={ticket.id}
      aria-label={t("teams.task.heading")}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      style={{
        // 门户到 document.body 后用 fixed 定位：原实现是 absolute，被祖先
        // `.scheduled-view`（absolute + z 30，overflow 由本视图内联成 hidden）的裁剪盒
        // 裁掉，且其层叠上下文把抽屉压到顶栏（--z-chrome=90）之下（裁切与封顶是两条
        // 独立机制，见组件注释）。fixed 以视口为包含块，门户后不再受祖先影响。
        // 几何交给 taskDetailDrawerGeometry：窄屏全宽低位、宽屏偏移夹取（css.md P2 #7）。
        position: "fixed",
        right: geometry.right,
        left: geometry.left,
        bottom: geometry.bottom,
        width: geometry.width,
        maxWidth: geometry.maxWidth,
        zIndex: "var(--z-popover)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-lg)",
        background: "var(--bg-panel)",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)",
        padding: 14,
        outline: "none",
      }}
      role="dialog"
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "var(--font-mono)", color: "var(--text-dim)", fontSize: "var(--fs-micro)" }}>
            #{ticket.id} · {t(ticketStateLabelKey(urgency))}
          </div>
          <h3 style={{ margin: "4px 0 0", fontSize: "var(--fs-body)", fontWeight: "var(--fw-semibold)", lineHeight: 1.35 }}>
            {ticket.subject}
          </h3>
        </div>
        <button
          type="button"
          className="agent-teams-timeline-button"
          onClick={onClose}
          aria-label={t("teams.task.close")}
          style={{ flex: "none" }}
        >
          ✕
        </button>
      </div>

      {ticket.description && (
        <p
          style={{
            margin: "10px 0 0",
            whiteSpace: "pre-wrap",
            fontSize: "var(--fs-small)",
            color: "var(--text-muted)",
            overflowWrap: "anywhere",
          }}
        >
          {ticket.description}
        </p>
      )}

      <div
        style={{
          marginTop: 12,
          paddingTop: 12,
          borderTop: "var(--hairline) solid var(--border)",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          fontSize: "var(--fs-small)",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          <span className="agent-teams-member-role">{t("teams.task.owner")}:</span>
          {ownerResolution?.memberId ? (
            <button
              type="button"
              onClick={() => {
                // 优先用解析到的成员实例（显式或回填）；名册里找不到时退回解析出的 id。
                if (owner) {
                  onSelectMember?.(owner.id);
                } else if (ownerResolution.memberId) {
                  onSelectMember?.(ownerResolution.memberId);
                }
              }}
              disabled={!onSelectMember}
              style={{
                border: "none",
                background: "none",
                padding: 0,
                color: "var(--accent)",
                cursor: onSelectMember ? "pointer" : "default",
                font: "inherit",
              }}
            >
              {ownerResolution.memberName ?? ownerResolution.memberId}
            </button>
          ) : (
            <span>{t("teams.unassigned")}</span>
          )}
          {ownerResolution?.inferred && (
            <span
              className="agent-teams-task-badge agent-teams-task-badge--inferred"
              data-testid="agent-teams-task-inferred-owner"
              style={{
                border: "var(--hairline) solid var(--info)",
                color: "var(--info)",
                borderRadius: 999,
                padding: "0 6px",
                fontSize: "var(--fs-micro)",
                whiteSpace: "nowrap",
              }}
            >
              {t("teams.task.inferredOwner")}
            </span>
          )}
          {ownerStalled && (
            <span
              className="agent-teams-task-badge agent-teams-task-badge--stalled"
              data-testid="agent-teams-task-stalled-owner"
              style={{
                border: "var(--hairline) solid var(--warning)",
                color: "var(--warning)",
                borderRadius: 999,
                padding: "0 6px",
                fontSize: "var(--fs-micro)",
                whiteSpace: "nowrap",
              }}
            >
              {t("teams.task.stalledOwner")}
            </span>
          )}
        </span>
        {chip(t("teams.task.dependsOn"), deps)}
        {chip(t("teams.task.unblocks"), unblocks)}
      </div>
    </aside>
  );
}

/**
 * 任务详情抽屉（C8）：点任务卡 → 右下角浮层显示负责人 / 依赖（本票依赖谁）/ 解锁（谁依赖本票）。
 *
 * **门户到 `document.body`**：工作台 `AgentTeamsView` 挂在 `.scheduled-view`
 * （`position:absolute` + `z-index:var(--z-sticky)`=30）里；该类自己只声明
 * `overflow-y:auto`，本视图再用内联 `style={{overflow:"hidden"}}` 把两轴都收成裁剪盒。
 * 准确的机制有两条（实测：把竞争侧栏降到 z-index:1、低于该容器的 30 后探针定位）：
 *   1. `absolute` 后代（本组件的原实现）：**同时**被祖先的层叠上下文封顶（压不过顶栏
 *      --z-chrome=90）**和**被祖先的 overflow 裁剪盒裁切——越界的 absolute 探针命中侧栏。
 *   2. `fixed` 后代：**不被**祖先 overflow 裁切（包含块是视口，除非某祖先建立了包含块
 *      transform/filter/will-change/contain），但**仍被**祖先层叠上下文封顶——越界的
 *      fixed 探针命中它自己，可证明裁切与封顶是两件独立的事。
 * 所以门户解决的是「封顶 + 裁剪」两颗钉子：脱离该子树后，`fixed` 定位才真正以视口为
 * 包含块。只抬高 `.scheduled-view` 的 z-index 会让整页盖住顶栏，不可取。
 *
 * SSR/首帧：服务端没有 `document`，挂载前渲染空（客户端组件；AppShell 以 ssr:false
 * 动态加载本视图，首帧空白不可见）。内容本身在 `AgentTeamTaskDetailBody`，便于 SSR 测试。
 */
export function AgentTeamTaskDetail(props: AgentTeamTaskDetailProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || typeof document === "undefined") return null;
  return createPortal(<AgentTeamTaskDetailBody {...props} />, document.body);
}
