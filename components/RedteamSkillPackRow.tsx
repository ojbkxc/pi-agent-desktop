"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "./SettingsUi";

interface RedteamPackStatus {
  bundled: boolean;
  total: number;
  installed: number;
  installedNames: string[];
}

/**
 * 可选「红队技能包」的安装/移除入口（Settings › Skills）。
 *
 * 默认不安装：点安装才把随应用打包的 23 个 SKILL.md 复制到用户技能根；移除只删本包
 * 记录过的目录。用途边界作为常驻文案显示，不做一次性提示。
 */
export function RedteamSkillPackRow({ onChanged }: { onChanged?: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<RedteamPackStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/skills/redteam");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { status?: RedteamPackStatus };
      if (!data.status) throw new Error("missing status");
      setStatus(data.status);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: "install" | "uninstall") => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch("/api/skills/redteam", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { status?: RedteamPackStatus };
      if (data.status) setStatus(data.status);
      onChanged?.();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  // A build without the bundled pack shows nothing rather than a dead button.
  if (!status?.bundled) return null;
  const installed = status.installed > 0;

  return (
    <div className="settings-option redteam-skill-pack" data-testid="redteam-skill-pack">
      <span className="settings-option-text">
        <span className="settings-option-title">{t("skills.redteamPack.title")}</span>
        <span className="settings-option-hint">{t("skills.redteamPack.notice")}</span>
        <span
          className={`settings-option-hint${failed ? " is-error" : ""}`}
          role="status"
          aria-live="polite"
        >
          {failed
            ? t("skills.redteamPack.failed")
            : installed
              ? t("skills.redteamPack.installed", { count: status.installed, total: status.total })
              : t("skills.redteamPack.available", { total: status.total })}
        </span>
      </span>
      <ConfigButton disabled={busy} onClick={() => void act(installed ? "uninstall" : "install")}>
        {busy
          ? t("i18n.saving")
          : installed
            ? t("skills.redteamPack.remove")
            : t("skills.redteamPack.install")}
      </ConfigButton>
    </div>
  );
}
