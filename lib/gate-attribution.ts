/**
 * Which layer of the host answered a turn, recorded — never decided.
 *
 * The question behind dsh-purge is legitimate: when a turn is cut short, was it
 * the model or was it the host? That is answered here by recording what each
 * gate already decided. Nothing here changes a decision: `recordGate()` returns
 * nothing, takes no verdict, and no caller reads `gateAttribution()` back to
 * branch on it. A gate that refused still refuses.
 *
 * Deliberately not under `lib/purge/`: attribution has to work with the purge
 * data plane off, and the dependency runs one way only — a gate may record, the
 * preset path must never reach a gate.
 *
 * Process-wide and bounded, like `lib/purge/stats.ts`: a ring of
 * `GATE_EVENT_MAX` events, nothing persisted, a restart starts from zero.
 */

/** The gates that can stop a turn, plus the model itself. */
export const GATE_LAYERS = [
  "tool-approval",
  "permission-gate",
  "project-trust",
  "mcp-trust",
  "model",
] as const;

export type GateLayer = (typeof GATE_LAYERS)[number];

/**
 * What a gate answered. There is no "asked": a confirmation that came back
 * `allowed` carries `reason: "confirmed"`, which is the count of prompts shown.
 */
export type GateDecision = "allowed" | "denied";

export interface GateEvent {
  at: number;
  layer: GateLayer;
  decision: GateDecision;
  /**
   * The gate's own short code (`rejected`, `timeout`, `fail-open-no-ui`,
   * `confirmed`, `not-trusted`). Never a command, a path, or a secret.
   */
  reason?: string;
}

export const GATE_EVENT_MAX = 500;

const events: GateEvent[] = [];

/**
 * Append what a gate answered.
 *
 * Returns nothing, so a caller cannot branch on the write, and accepts no
 * decision, so a recorder cannot author one.
 */
export function recordGate(event: { layer: GateLayer; decision: GateDecision; reason?: string }): void {
  events.push({
    at: Date.now(),
    layer: event.layer,
    decision: event.decision,
    ...(event.reason ? { reason: event.reason } : {}),
  });
  if (events.length > GATE_EVENT_MAX) events.splice(0, events.length - GATE_EVENT_MAX);
}

/** A copy, so a reader cannot mutate the ring. */
export function gateSnapshot(): GateEvent[] {
  return events.map((event) => ({ ...event }));
}

/** Forget everything; for tests. */
export function clearGateEvents(): void {
  events.length = 0;
}

/** Turns per layer and per verdict — the model-versus-host split. */
export function gateAttribution(): {
  byLayer: Record<GateLayer, number>;
  byDecision: Record<GateDecision, number>;
} {
  const byLayer = Object.fromEntries(GATE_LAYERS.map((layer) => [layer, 0])) as Record<GateLayer, number>;
  const byDecision: Record<GateDecision, number> = { allowed: 0, denied: 0 };
  for (const event of events) {
    byLayer[event.layer] += 1;
    byDecision[event.decision] += 1;
  }
  return { byLayer, byDecision };
}

/**
 * 只读视图：哪个闸门拦了多少次，以及本进程最近 `GATE_EVENT_MAX` 条闸门事件。
 *
 * 由 `app/api/purge/gate-log/route.ts` 直接回答。route.ts 只能导出 Next 的约定名
 * （`scripts/route-exports.test.mjs`），所以这段合成放在这里。它记录、不参与判定：
 * 不写盘、不改设置、不连接任何东西；`reason` 只有代码（`rejected`、`timeout`、
 * `not-trusted`），永不包含命令、路径或密钥。
 */
export function gateLogPayload() {
  return { attribution: gateAttribution(), events: gateSnapshot() };
}
