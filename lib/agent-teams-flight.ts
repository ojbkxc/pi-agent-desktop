/**
 * 编队图上的消息飞行路线（移植自 cc-haha `AgentTeamsCanvas.tsx` 的
 * `flightRoutes` / `flightRouteToRecipient`）。
 *
 * 为什么不在泳道里画连线：每条消息一根曲线时，同一对成员的多条消息会叠成
 * 一团乱线，还横穿整张时间轴。cc-haha 的做法是把流向收敛到编队图的两条共享
 * 总线（lead bus / peer bus），一次只让一条消息沿总线飞过，泳道只留事件节点。
 *
 * 本文件是纯几何：输入一条消息 + 成员坐标，输出路径与标签键；不依赖 DOM。
 */
import {
  LEAD_BUS_Y,
  LEAD_FOOT,
  MEMBER_FOOT,
  MEMBER_TOP,
  PEER_BUS_Y,
} from "./agent-teams-formation-layout.ts";
import type { WorkbenchMessage } from "./agent-teams-swimlane";

export interface FlightNode {
  id: string;
  name: string;
  /** 成员卡的水平中心（编队布局给出）。 */
  centerX: number;
  isLead: boolean;
}

export type FlightTone = "assignment" | "report" | "peer" | "system";

export interface FormationFlight {
  key: string;
  /** 走哪条共享总线。 */
  channel: "lead" | "peer";
  tone: FlightTone;
  /** i18n 键（`teams.communication.*`），调用方本地化。 */
  labelKey: string;
  /** SVG polyline 路径。 */
  d: string;
  /** 标签锚点（总线中点上方）。 */
  chipX: number;
  chipY: number;
}

/** 身份别名：同时认全名与 `name@team` 短名（与通信流同口径）。 */
function aliases(value: string | undefined): string[] {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return [];
  const short = normalized.split("@")[0] ?? normalized;
  return normalized === short ? [normalized] : [normalized, short];
}

function matches(node: FlightNode, identity: string | undefined): boolean {
  const target = aliases(identity);
  if (target.length === 0) return false;
  const own = [...aliases(node.id), ...aliases(node.name)];
  return target.some((alias) => own.includes(alias));
}

function nodeFor(nodes: readonly FlightNode[], identity: string | undefined): FlightNode | undefined {
  return nodes.find((node) => matches(node, identity));
}

function polyline(points: ReadonlyArray<readonly [number, number]>): string {
  return points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x},${y}`).join(" ");
}

/** 一条消息的语义色调：系统事件 > 队长派工 > 向队长汇报/广播 > 同侪。 */
function toneOf(message: WorkbenchMessage, sender: FlightNode, recipient: FlightNode): FlightTone {
  if (message.kind === "system" || message.protocolType) return "system";
  if (sender.isLead) return "assignment";
  if (recipient.isLead || message.kind === "broadcast" || message.to === "*") return "report";
  return "peer";
}

function labelKeyOf(tone: FlightTone): string {
  return `teams.communication.${tone}`;
}

/** 队长 ↔ 成员：竖线出卡 → 共享 lead bus → 竖线入卡。 */
function leadFlight(
  message: WorkbenchMessage,
  sender: FlightNode,
  recipient: FlightNode,
  lead: FlightNode,
): FormationFlight {
  const worker = sender.isLead ? recipient : sender;
  const leadToWorker: Array<[number, number]> = [
    [lead.centerX, LEAD_FOOT],
    [lead.centerX, LEAD_BUS_Y],
    [worker.centerX, LEAD_BUS_Y],
    [worker.centerX, MEMBER_TOP],
  ];
  const points = sender.isLead ? leadToWorker : leadToWorker.slice().reverse();
  const tone = toneOf(message, sender, recipient);
  return {
    key: `${message.id}:lead:${sender.id}->${recipient.id}`,
    channel: "lead",
    tone,
    labelKey: labelKeyOf(tone),
    d: polyline(points),
    chipX: (lead.centerX + worker.centerX) / 2,
    chipY: LEAD_BUS_Y - 10,
  };
}

/** 成员 ↔ 成员：同一条 peer bus。 */
function peerFlight(message: WorkbenchMessage, sender: FlightNode, recipient: FlightNode): FormationFlight {
  const tone = toneOf(message, sender, recipient);
  return {
    key: `${message.id}:peer:${sender.id}->${recipient.id}`,
    channel: "peer",
    tone,
    labelKey: labelKeyOf(tone),
    d: polyline([
      [sender.centerX, MEMBER_FOOT],
      [sender.centerX, PEER_BUS_Y],
      [recipient.centerX, PEER_BUS_Y],
      [recipient.centerX, MEMBER_FOOT],
    ]),
    chipX: (sender.centerX + recipient.centerX) / 2,
    chipY: PEER_BUS_Y - 10,
  };
}

/**
 * 一条消息 → 0..N 条飞行路线（广播会展开成每个收件人一条）。
 * 发送方不在编队里、没有收件人、或收发是同一人时返回空数组。
 */
export function formationFlights(
  message: WorkbenchMessage | undefined,
  nodes: readonly FlightNode[],
): FormationFlight[] {
  if (!message || nodes.length === 0) return [];
  const sender = nodeFor(nodes, message.from);
  if (!sender) return [];

  const isBroadcast = message.kind === "broadcast" || message.to === "*";
  const explicit = (message.recipients ?? []).filter((recipient) => recipient !== "*");
  const recipients = isBroadcast
    ? (explicit.length > 0 ? explicit.map((identity) => nodeFor(nodes, identity)) : nodes.filter((node) => !matches(node, message.from)))
    : [nodeFor(nodes, message.to)];

  const unique = new Map<string, FlightNode>();
  for (const node of recipients) {
    if (!node || node.id === sender.id || unique.has(node.id)) continue;
    unique.set(node.id, node);
  }

  return [...unique.values()].flatMap((recipient) => {
    if (sender.isLead || recipient.isLead) {
      // Use the actual lead endpoint rather than "the first lead node": with a
      // malformed roster the two can differ, and the path must land on the card
      // that actually sent/received.
      return [leadFlight(message, sender, recipient, sender.isLead ? sender : recipient)];
    }
    return [peerFlight(message, sender, recipient)];
  });
}
