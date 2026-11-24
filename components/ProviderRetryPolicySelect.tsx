"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSelect } from "@/components/AppSelect";
import { ConfigField } from "@/components/SettingsUi";
import { useI18n } from "@/hooks/useI18n";
import { MODEL_RETRY_POLICIES, type ModelRetryPolicy } from "@/lib/outage/retry-policy";

/**
 * 每个模型 API 自己的重试口径（用户需求：添加模型 API 时可以选择该 API 的重试策略）。
 *
 * 三个档位的语义（后端 `lib/outage/retry-policy.ts` 是唯一判据）：
 * - `default`：现有行为——临时错误交给 SDK 既有的重试，其余直接按失败上报；
 * - `transient`：只重试被判定为临时性的错误；
 * - `all`：**所有**失败都持续重试，直到成功或本轮被 Stop。
 *
 * 为什么不写进 models.json：那是 pi 的配置格式，多出来的 provider 字段会被它当成
 * 非法键。策略存在 pi-web 自己的 settings.json（`modelRetryPolicy`），按 provider id 键控。
 *
 * 读失败按 `default` 渲染（与服务端归一化口径一致）；保存失败回退到旧值并提示，绝不
 * 让界面显示一个没落盘的策略——那会让人以为「已经开了」，实际下一轮照样失败即停。
 */
export function ProviderRetryPolicySelect({ providerId }: { providerId: string }) {
  const { t } = useI18n();
  const [policy, setPolicy] = useState<ModelRetryPolicy>("default");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    fetch(`/api/model-retry-policy?provider=${encodeURIComponent(providerId)}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((data: { policy?: ModelRetryPolicy }) => {
        if (cancelled) return;
        const next = MODEL_RETRY_POLICIES.includes(data.policy as ModelRetryPolicy) ? data.policy! : "default";
        setPolicy(next);
        setLoaded(true);
      })
      .catch(() => {
        // A read failure must not block the panel: show the default and let the
        // next save overwrite whatever the file actually holds.
        if (!cancelled) {
          setPolicy("default");
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  const change = useCallback(
    async (value: ModelRetryPolicy) => {
      const previous = policy;
      setPolicy(value);
      setSaving(true);
      setError(null);
      try {
        const response = await fetch("/api/model-retry-policy", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: providerId, policy: value }),
        });
        if (!response.ok) throw new Error(String(response.status));
      } catch {
        setPolicy(previous);
        setError(t("models.retryPolicySaveFailed"));
      } finally {
        setSaving(false);
      }
    },
    [policy, providerId, t],
  );

  const options: { value: ModelRetryPolicy; label: string }[] = [
    { value: "default", label: t("models.retryPolicyDefault") },
    { value: "transient", label: t("models.retryPolicyTransient") },
    { value: "all", label: t("models.retryPolicyAll") },
  ];

  return (
    <ConfigField label={t("models.fieldRetryPolicy")}>
      <AppSelect
        value={policy}
        onValueChange={(value) => change(value as ModelRetryPolicy)}
        disabled={!loaded || saving}
        aria-label={t("models.fieldRetryPolicy")}
        options={options}
      />
      <span style={{ fontSize: "var(--fs-micro)", color: "var(--text-dim)", marginTop: 2 }}>
        {policy === "all" ? t("models.retryPolicyAllHint") : t("models.retryPolicyHint")}
      </span>
      {error && (
        <span style={{ fontSize: "var(--fs-micro)", color: "var(--danger)", marginTop: 2 }}>{error}</span>
      )}
    </ConfigField>
  );
}
