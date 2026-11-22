"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

/**
 * 破甲控制台的「闸门归属」只读视图（`GET /api/purge/gate-log`）。
 *
 * 数据由 `lib/gate-attribution.ts` 的 `gateLogPayload()` 给出：各闸门做了多少次
 * allowed/denied，以及本进程最近的闸门事件。它只读、不改变任何判定；`reason`
 * 永远只是短代码（如 `rejected` / `timeout`），不含命令、路径或密钥。
 *
 * 这里只做展示：容器负责取数，`PurgeGateLogView` 是纯展示层，便于 SSR 单测。
 */

export const GATE_LAYERS = ["tool-approval", "permission-gate", "project-trust", "mcp-trust", "model"] as const;
export type GateLayer = (typeof GATE_LAYERS)[number];

export interface GateLogEvent {
  at: number;
  layer: GateLayer;
  decision: "allowed" | "denied";
  reason?: string;
}

export interface GateLogData {
  attribution: { byLayer: Record<GateLayer, number>; byDecision: { allowed: number; denied: number } };
  events: GateLogEvent[];
}

function countOf(raw: unknown): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function isGateLayer(value: unknown): value is GateLayer {
  return typeof value === "string" && (GATE_LAYERS as readonly string[]).includes(value);
}

/** 校验并归一化路由返回；形状不对返回 null（展示层据此显示失败态）。 */
export function asGateLogData(raw: unknown): GateLogData | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const attribution = root.attribution;
  if (!attribution || typeof attribution !== "object") return null;
  const attr = attribution as Record<string, unknown>;
  const byDecisionRaw = attr.byDecision;
  if (!byDecisionRaw || typeof byDecisionRaw !== "object") return null;
  const decisions = byDecisionRaw as Record<string, unknown>;
  const byLayerRaw = attr.byLayer && typeof attr.byLayer === "object" ? (attr.byLayer as Record<string, unknown>) : {};
  const byLayer = Object.fromEntries(GATE_LAYERS.map((layer) => [layer, countOf(byLayerRaw[layer])])) as Record<GateLayer, number>;
  const events: GateLogEvent[] = [];
  if (Array.isArray(root.events)) {
    for (const item of root.events) {
      if (!item || typeof item !== "object") continue;
      const event = item as Record<string, unknown>;
      if (!isGateLayer(event.layer)) continue;
      if (event.decision !== "allowed" && event.decision !== "denied") continue;
      const at = Number(event.at);
      events.push({
        at: Number.isFinite(at) ? at : 0,
        layer: event.layer,
        decision: event.decision,
        ...(typeof event.reason === "string" && event.reason ? { reason: event.reason } : {}),
      });
    }
  }
  return {
    attribution: {
      byLayer,
      byDecision: { allowed: countOf(decisions.allowed), denied: countOf(decisions.denied) },
    },
    events,
  };
}

export function PurgeGateLogView({ data, failed }: { data: GateLogData | null; failed: boolean }) {
  const { t } = useI18n();
  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("purge.gateLog.title")}</h3>
      <p className="settings-general-description">{t("purge.gateLog.hint")}</p>
      {failed ? (
        <p className="settings-purge-empty" role="alert">{t("purge.gateLog.loadFailed")}</p>
      ) : data === null ? (
        <p className="settings-purge-empty" role="status">{t("purge.gateLog.loading")}</p>
      ) : (
        <>
          <p className="settings-general-description">
            {t("purge.gateLog.summary", { allowed: data.attribution.byDecision.allowed, denied: data.attribution.byDecision.denied })}
          </p>
          <table className="settings-purge-table">
            <thead>
              <tr>
                <th>{t("purge.gateLog.layerHeader")}</th>
                <th>{t("purge.gateLog.countHeader")}</th>
              </tr>
            </thead>
            <tbody>
              {GATE_LAYERS.map((layer) => (
                <tr key={layer}>
                  <td>{layer}</td>
                  <td>{data.attribution.byLayer[layer]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="settings-general-description">{t("purge.gateLog.recent")}</p>
          {data.events.length === 0 ? (
            <p className="settings-purge-empty">{t("purge.gateLog.empty")}</p>
          ) : (
            <ul className="settings-purge-gate-log">
              {data.events.slice(-20).reverse().map((event, index) => (
                <li key={`${event.at}-${event.layer}-${index}`}>
                  <span>{new Date(event.at).toLocaleTimeString()}</span>
                  {" · "}
                  <span>{event.layer}</span>
                  {" · "}
                  <span>{event.decision === "allowed" ? t("purge.gateLog.decision.allowed") : t("purge.gateLog.decision.denied")}</span>
                  {event.reason ? <span>{` · ${event.reason}`}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function PurgeGateLogSection() {
  const [data, setData] = useState<GateLogData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/purge/gate-log", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((json) => {
        if (cancelled) return;
        const parsed = asGateLogData(json);
        if (parsed) {
          setData(parsed);
          setFailed(false);
        } else {
          setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, []);

  return <PurgeGateLogView data={data} failed={failed} />;
}
