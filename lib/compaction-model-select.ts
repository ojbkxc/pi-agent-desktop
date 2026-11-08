import type { CompactionModelChoice } from "./compaction-policy";

/**
 * Which model writes a compaction summary (v0.8.2 plan, "压缩模型选择与执行").
 *
 * Pure and dependency-free (type-only imports) so the ordering rules can be
 * tested with plain objects and injected price trust. The executor in
 * `lib/compaction-extension.ts` calls the SDK's `compact()` with each
 * candidate in the returned order.
 *
 * The cache-alignment rule comes first: when the main model is itself a
 * Flash-class or cheap model, the summary request stays on it. A second model
 * would mean a cold start on another credential for a request that already
 * shares most of its prefix with the main conversation; the savings are
 * negligible and the failure surface larger.
 *
 * The chain never contains the main model as an implicit final entry. Running
 * out of candidates returns `undefined` from the extension so the SDK's own
 * native path summarizes with the current model — that path already is "main
 * model last" and must not be replaced by a duplicate request.
 */

/** "极低" price: the Flash-Lite tier (e.g. 0.25 in / 1.5 out USD per MTok). */
export const LOW_PRICE_INPUT_PER_MTOK = 0.25;
export const LOW_PRICE_OUTPUT_PER_MTOK = 1.5;

/** Output room reserved when checking a candidate's window (mirrors the SDK's summary cap). */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 16_384;

/** System prompt + instructions room in a summarization request. */
export const DEFAULT_SUMMARIZATION_OVERHEAD_TOKENS = 1_024;

/** `pi-virtual` entries are routers; requests for them must go through ModelRuntime. */
const VIRTUAL_MODEL_API = "pi-virtual";

/** Spark-X2.6's limited-time free tier, matched by id or display name. */
const SPARK_FREE_HINT_RE = /spark[-_ ]?x2\.6/i;

/** Other "free"-sounding names. Only a name hint, never proof of a free price. */
const FREE_NAME_RE = /(?:^|[-_.\s])free(?:$|[-_.\s])|限免|限时免费|免费/i;

export interface CompactionModelCostLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * The subset of `Model<Api>` the selection needs. A real SDK model satisfies
 * it structurally; tests pass plain objects.
 */
export interface CompactionModelLike {
  provider: string;
  id: string;
  name?: string;
  api?: string;
  /** `chat` is the SDK default when absent. */
  type?: string;
  cost?: CompactionModelCostLike | null;
  contextWindow?: number;
  maxTokens?: number;
}

export type CompactionPriceKind = "free" | "low" | "priced" | "unknown";

export interface CompactionPriceAssessment {
  kind: CompactionPriceKind;
  input?: number;
  output?: number;
  /**
   * Whether the rates can be trusted as the real catalog price.
   *
   * The SDK composes a models.json model without a `cost` block as
   * `{ input: 0, output: 0, ... }` (provider-composer), so a literal 0/0 is
   * indistinguishable from "free" unless the caller knows where the number
   * came from. Positive rates are always real; only zeros depend on
   * `isZeroPriceTrusted`.
   */
  confirmed: boolean;
}

export type CompactionCandidateTier =
  | "main"
  | "preferred"
  | "confirmed-free"
  | "flash"
  | "unconfirmed";

export type CompactionCandidateReason =
  | "main-flash"
  | "main-low-price"
  | "main-preferred"
  | "preferred"
  | "free-named"
  | "free"
  | "flash"
  | "name-unconfirmed";

export interface CompactionModelCandidate<M extends CompactionModelLike = CompactionModelLike> {
  model: M;
  /** `provider/modelId`, the identity used for de-duplication and diagnostics. */
  ref: string;
  tier: CompactionCandidateTier;
  price: CompactionPriceAssessment;
  reason: CompactionCandidateReason;
}

export interface SelectCompactionModelsInput<M extends CompactionModelLike> {
  /** The session's current model (`ctx.model`); may be a virtual router. */
  mainModel?: M | null;
  /** Models with working credentials (`modelRegistry.getAvailable()`). */
  availableModels: readonly M[];
  choice: CompactionModelChoice;
  /** Explicit `provider/modelId` entries from the policy, in the user's order. */
  preferredModels?: readonly string[];
  /** Estimated input tokens of this preparation's summarization request. */
  requestTokens: number;
  /**
   * Whether a catalog 0/0 cost is a real price. Defaults to trusting it, which
   * is what the plan's "input/output 均为 0" rule asks for; a wiring layer that
   * reads models.json can be stricter.
   */
  isZeroPriceTrusted?: (model: M) => boolean;
}

const trustEveryZeroPrice = (): boolean => true;

/** Stable identity across catalog duplicates. */
export function compactionModelRef(model: Pick<CompactionModelLike, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

/** A virtual model routes requests; it can never be passed to `compact()` itself. */
export function isVirtualCompactionModel(model: Pick<CompactionModelLike, "api">): boolean {
  return model.api === VIRTUAL_MODEL_API;
}

/** Image and classifier entries are not usable for a summary request. */
export function isChatCompactionModel(model: Pick<CompactionModelLike, "type">): boolean {
  return (model.type ?? "chat") === "chat";
}

export function isFlashCompactionModel(model: Pick<CompactionModelLike, "id" | "name">): boolean {
  return /flash/i.test(model.id) || /flash/i.test(model.name ?? "");
}

export function isSparkFreeCompactionModel(model: Pick<CompactionModelLike, "id" | "name">): boolean {
  return SPARK_FREE_HINT_RE.test(model.id) || SPARK_FREE_HINT_RE.test(model.name ?? "");
}

/** `hy4free`, `hy4std`, ... — a candidate rule, never a claim of a free price. */
export function isHyCompactionModel(model: Pick<CompactionModelLike, "id">): boolean {
  return /^hy/i.test(model.id);
}

/** Any "free"-sounding identity. Only a name hint; the price decides. */
export function hasFreeNameHint(model: Pick<CompactionModelLike, "id" | "name">): boolean {
  const name = model.name ?? "";
  return (
    isHyCompactionModel(model)
    || isSparkFreeCompactionModel(model)
    || FREE_NAME_RE.test(model.id)
    || FREE_NAME_RE.test(name)
  );
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Classify a model's catalog price. Missing or malformed metadata is
 * `unknown`, never "free": the plan forbids claiming a free price from a name
 * or from absent data.
 */
export function assessCompactionModelPrice<M extends Pick<CompactionModelLike, "cost">>(
  model: M,
  isZeroPriceTrusted: (model: M) => boolean = trustEveryZeroPrice,
): CompactionPriceAssessment {
  const input = finiteNumber(model.cost?.input);
  const output = finiteNumber(model.cost?.output);
  if (input === undefined || output === undefined) {
    return { kind: "unknown", confirmed: false };
  }
  if (input <= 0 && output <= 0) {
    return { kind: "free", input, output, confirmed: isZeroPriceTrusted(model) };
  }
  if (input <= LOW_PRICE_INPUT_PER_MTOK && output <= LOW_PRICE_OUTPUT_PER_MTOK) {
    return { kind: "low", input, output, confirmed: true };
  }
  return { kind: "priced", input, output, confirmed: true };
}

function isUsableTokenCount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Whether `model` can take this preparation's summarization request. A model
 * with an unknown window is skipped rather than guessed at; the SDK never
 * truncates a summary input, so a too-small candidate would only fail.
 */
export function compactionModelFitsPreparation(
  model: Pick<CompactionModelLike, "contextWindow" | "maxTokens">,
  requestTokens: number,
): boolean {
  const window = model.contextWindow;
  if (!isUsableTokenCount(window)) return false;
  if (!Number.isFinite(requestTokens) || requestTokens < 0) return false;
  const outputReserve = isUsableTokenCount(model.maxTokens)
    ? model.maxTokens
    : DEFAULT_OUTPUT_RESERVE_TOKENS;
  const reserve = Math.min(outputReserve, Math.floor(window / 2));
  return requestTokens + reserve <= window;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function splitModelRef(ref: string): { provider: string; modelId: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash >= ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

/**
 * Price ordering for the cheaper tiers: confirmed prices first, then the
 * cheaper input/output rate, then a larger window, then stable ids.
 */
function comparePaidCandidates(a: CompactionModelCandidate, b: CompactionModelCandidate): number {
  const aKnown = a.price.kind !== "unknown";
  const bKnown = b.price.kind !== "unknown";
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  if (aKnown && bKnown) {
    const input = compareNumbers(a.price.input ?? 0, b.price.input ?? 0);
    if (input !== 0) return input;
    const output = compareNumbers(a.price.output ?? 0, b.price.output ?? 0);
    if (output !== 0) return output;
  }
  const window = compareNumbers(b.model.contextWindow ?? 0, a.model.contextWindow ?? 0);
  if (window !== 0) return window;
  return compareStrings(a.model.provider, b.model.provider) || compareStrings(a.model.id, b.model.id);
}

/** Free-name ranking: Spark's limited free tier, then `hy*`, then anything else. */
function freeNameRank(model: CompactionModelLike): number {
  if (isSparkFreeCompactionModel(model)) return 0;
  if (isHyCompactionModel(model)) return 1;
  return 2;
}

function compareFreeCandidates(a: CompactionModelCandidate, b: CompactionModelCandidate): number {
  const rank = compareNumbers(freeNameRank(a.model), freeNameRank(b.model));
  if (rank !== 0) return rank;
  return comparePaidCandidates(a, b);
}

function compareNameOnlyCandidates(a: CompactionModelCandidate, b: CompactionModelCandidate): number {
  const rank = compareNumbers(freeNameRank(a.model), freeNameRank(b.model));
  if (rank !== 0) return rank;
  return compareStrings(a.model.provider, b.model.provider) || compareStrings(a.model.id, b.model.id);
}

/**
 * Build the ordered compaction-model chain for one compaction run.
 *
 * `auto`        — main model first when it is Flash/cheap or in `preferredModels`,
 *                 then explicit preferences, confirmed-free models, Flash-class
 *                 models, and finally unconfirmed name hints.
 * `current`     — the main model only (the SDK native path is the fallback).
 * `preferred`   — the explicit list only (main model stays the SDK's fallback).
 *
 * Every entry is chat-typed, non-virtual, credentialed (`availableModels`),
 * de-duplicated by `provider/modelId`, and large enough for `requestTokens`.
 */
export function selectCompactionModels<M extends CompactionModelLike>(
  input: SelectCompactionModelsInput<M>,
): CompactionModelCandidate<M>[] {
  const available = new Map<string, M>();
  for (const model of input.availableModels ?? []) {
    if (!model || typeof model.provider !== "string" || typeof model.id !== "string") continue;
    if (model.provider.length === 0 || model.id.length === 0) continue;
    if (isVirtualCompactionModel(model) || !isChatCompactionModel(model)) continue;
    const ref = compactionModelRef(model);
    if (!available.has(ref)) available.set(ref, model);
  }

  const preferredRefs = (input.preferredModels ?? [])
    .map((ref) => ref.trim())
    .filter((ref) => splitModelRef(ref) !== undefined);

  const candidates: CompactionModelCandidate<M>[] = [];
  const usedRefs = new Set<string>();
  const push = (model: M, tier: CompactionCandidateTier, reason: CompactionCandidateReason): void => {
    const ref = compactionModelRef(model);
    if (usedRefs.has(ref)) return;
    usedRefs.add(ref);
    candidates.push({
      model,
      ref,
      tier,
      reason,
      price: assessCompactionModelPrice(model, input.isZeroPriceTrusted),
    });
  };
  const usable = (model: M | undefined | null): model is M => (
    model !== undefined
    && model !== null
    && typeof model.provider === "string"
    && typeof model.id === "string"
    && available.has(compactionModelRef(model))
    && compactionModelFitsPreparation(model, input.requestTokens)
  );

  if (input.choice === "current") {
    const main = input.mainModel ? available.get(compactionModelRef(input.mainModel)) : undefined;
    if (usable(main)) push(main, "main", isFlashCompactionModel(main) ? "main-flash" : "main-low-price");
    return candidates;
  }

  if (input.choice === "preferred") {
    for (const ref of preferredRefs) {
      const model = available.get(ref);
      if (usable(model)) push(model, "preferred", "preferred");
    }
    return candidates;
  }

  // Step 0 — keep the summary on the main model when that is already the cheap
  // choice (cache alignment; never search for something cheaper).
  const main = input.mainModel ? available.get(compactionModelRef(input.mainModel)) : undefined;
  if (usable(main)) {
    const mainRef = compactionModelRef(main);
    if (preferredRefs.includes(mainRef)) {
      push(main, "main", "main-preferred");
      return candidates;
    }
    if (isFlashCompactionModel(main)) {
      push(main, "main", "main-flash");
      return candidates;
    }
    const price = assessCompactionModelPrice(main, input.isZeroPriceTrusted);
    if (price.kind === "free" || price.kind === "low") {
      push(main, "main", "main-low-price");
      return candidates;
    }
  }

  const free: CompactionModelCandidate<M>[] = [];
  const flash: CompactionModelCandidate<M>[] = [];
  const named: CompactionModelCandidate<M>[] = [];

  for (const ref of preferredRefs) {
    const model = available.get(ref);
    if (usable(model)) push(model, "preferred", "preferred");
  }

  for (const [ref, model] of available) {
    if (usedRefs.has(ref) || !usable(model)) continue;
    if (model === main) continue; // the SDK's native path runs the main model last
    const price = assessCompactionModelPrice(model, input.isZeroPriceTrusted);
    const candidate: CompactionModelCandidate<M> = {
      model,
      ref,
      tier: "flash",
      price,
      reason: "flash",
    };
    if (price.kind === "free" && price.confirmed) {
      free.push({ ...candidate, tier: "confirmed-free", reason: hasFreeNameHint(model) ? "free-named" : "free" });
    } else if (isFlashCompactionModel(model)) {
      flash.push(candidate);
    } else if (price.kind === "unknown" && hasFreeNameHint(model)) {
      named.push({ ...candidate, tier: "unconfirmed", reason: "name-unconfirmed" });
    }
  }

  free.sort(compareFreeCandidates);
  flash.sort(comparePaidCandidates);
  named.sort(compareNameOnlyCandidates);
  for (const candidate of [...free, ...flash, ...named]) push(candidate.model, candidate.tier, candidate.reason);

  return candidates;
}