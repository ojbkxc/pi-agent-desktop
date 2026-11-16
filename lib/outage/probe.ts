/**
 * 轻量恢复探针（server-only）：1-token 请求，确认 provider 真的活了。
 *
 * 前 3 次直接续跑（连接失败不产生 token，成本≈0）；之后走这里，避免恢复瞬间
 * 反复重放长上下文（设计 §3 两段式探测）。
 *
 * 复用 Models 测试页的同一套路径（`app/api/models-config/test/route.ts`）：
 * `getModelRuntimeWithExtensions()` 拿到带扩展 provider 的运行时，
 * `completeSimple` 发一条 16 token 的请求，`maxRetries: 0`（探针自己就是重试）。
 *
 * 探针**不产生会话副作用**：不发消息、不写会话文件；结果只影响调度器下一次
 * 是否续跑。失败一律按「仍不可用」，绝不抛。
 */
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { getModelRuntimeWithExtensions } from "../model-runtime";
import type { OutageRecord } from "./types";

const PROBE_TIMEOUT_MS = 15_000;

/** `record.origin` 不可用（没有 provider/modelId）⇒ 无法探针，直接放行续跑。 */
export async function probeProviderAvailable(record: OutageRecord): Promise<boolean> {
  const provider = record.origin.provider;
  const modelId = record.origin.modelId;
  if (!provider || !modelId) return true;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const modelRuntime = await getModelRuntimeWithExtensions();
    const model = modelRuntime.getModel(provider, modelId);
    if (!model) return false; // 模型没了不是恢复
    const resolved = await modelRuntime.getAuth(model);
    if (!resolved?.auth.apiKey) return false;
    const message = await completeSimple(model, {
      messages: [{ role: "user", content: "Reply with OK only.", timestamp: Date.now() }],
    }, {
      apiKey: resolved.auth.apiKey,
      headers: resolved.auth.headers,
      maxTokens: 16,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxRetries: 0,
      cacheRetention: "none",
      signal: controller.signal,
    });
    return message.stopReason !== "error" && message.stopReason !== "aborted";
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/** lazy import 让 instrumentation 的启动路径不预先加载 pi-ai。 */
export function buildOutageProbe(record: OutageRecord): Promise<boolean> {
  return probeProviderAvailable(record);
}