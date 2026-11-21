import {
  readAutopilotSettings,
  isAutopilotOriginatedSession,
  type AutopilotSettings,
} from "./autopilot";
import { buildUserApprovalPrompt, checkPlanIdentity } from "./agent-teams-plan";
import { readTeamPlanView } from "./agent-teams-plan-store";
import { findTeamBySession, resolveTeamLeadSession } from "./agent-teams-swimlane-store";
import { defaultDeliver, type DeliveryResult } from "./agent-teams-unattended-runtime";

/**
 * Unattended team approval.
 *
 * A desktop session may only auto-approve a plan when it was itself started by
 * unattended work (a scheduled run or an autofix task) and the autopilot switch
 * is on. Manual sessions keep the mandatory human review.
 *
 * The marker list itself lives in `lib/autopilot.ts` so `lib/rpc-manager.ts`
 * can share it without pulling this module (and the delivery seam) in.
 */
export { AUTOPILOT_SESSION_MARKERS, isAutopilotOriginatedSession } from "./autopilot";

/** In-process idempotency: one delivery per plan revision. */
const delivered = new Set<string>();

/** Pure gate: both the master switch and the per-feature flag must be on. */
export function shouldAutoApprove(settings: AutopilotSettings, customTypes: readonly string[]): boolean {
  return settings.enabled && settings.autoApproveTeamPlans && isAutopilotOriginatedSession(customTypes);
}

export interface AutoApproveResult {
  approved: boolean;
  reason?: string;
}

/**
 * Deliver the approval prompt to a team's lead when the settled session is an
 * autopilot session and its team has a plan awaiting review.
 *
 * The actual approve + launch is still done by the lead through `team_plan`
 * (the desktop never writes `plan.json`); this only removes the human click.
 */
export async function autoApproveTeamPlanForSession(input: {
  sessionId: string;
  customTypes: readonly string[];
  settingsPath?: string;
  /**
   * Test seam: how the approval prompt reaches the lead session. Omitted, the
   * real `defaultDeliver` (send to the live lead, or revive it) is used, so
   * production behaviour is unchanged.
   */
  deliver?: (sessionId: string, message: string) => Promise<DeliveryResult>;
}): Promise<AutoApproveResult> {
  const settings = readAutopilotSettings(input.settingsPath);
  if (!shouldAutoApprove(settings, input.customTypes)) return { approved: false, reason: "disabled" };

  const team = await findTeamBySession(input.sessionId);
  if (!team) return { approved: false, reason: "no-team" };
  const plan = await readTeamPlanView(team);
  if (!plan) return { approved: false, reason: "no-plan" };
  if (plan.state !== "review_pending") return { approved: false, reason: `state ${plan.state}` };

  const key = `${input.sessionId}:${plan.planId}:${plan.revision}`;
  if (delivered.has(key)) return { approved: false, reason: "already-delivered" };

  const identity = checkPlanIdentity(plan, {
    planId: plan.planId,
    sessionId: plan.sessionId,
    incarnationId: plan.incarnationId,
    expectedRevision: plan.revision,
  });
  if (!identity.ok) return { approved: false, reason: identity.reason };

  const leadSessionId = await resolveTeamLeadSession(team).catch(() => null);
  const deliverTo = leadSessionId ?? plan.sessionId;
  const deliver = input.deliver ?? defaultDeliver;
  const result = await deliver(deliverTo, buildUserApprovalPrompt(plan));
  if (!result.ok) return { approved: false, reason: result.reason ?? "delivery failed" };

  delivered.add(key);
  // The set only guards retries within this process. Evict the oldest key, not
  // the whole set: clearing would drop the delivery just recorded, so the very
  // next retry could deliver the same plan revision again.
  while (delivered.size > 200) {
    const oldest = delivered.values().next().value;
    if (oldest === undefined) break;
    delivered.delete(oldest);
  }
  console.warn(`[pi-web] autopilot: auto-approved plan ${plan.planId} r${plan.revision} for team ${team}`);
  return { approved: true };
}
