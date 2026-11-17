"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { I18nProvider, useI18n } from "@/hooks/useI18n";

/**
 * 手机扫码打开的配对页（二维码内容见 app/api/public-access/pair/qr/route.ts）。
 *
 * 只做三件事：把 URL 里的一次性 secret 交给 /api/public-access/pair 换一条
 * pending 请求；轮询 /api/public-access/pair/claim 直到电脑上批准；拿到
 * `__Host-pi-remote` Cookie 后进入 Pi。页面本身不接触 device token ——
 * Cookie 是 HttpOnly 的，JS 读不到。
 */
type Phase = "loading" | "waiting" | "rejected" | "expired" | "limit" | "failed";

/** 设备列表里显示的名字（存到电脑上的一次性标签，不是浏览器指纹）。 */
function deviceLabel(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const platform = /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
      : /Android/.test(ua) ? "Android"
        : /Macintosh/.test(ua) ? "Mac"
          : /Windows/.test(ua) ? "Windows"
            : "Phone";
  const browser = /EdgA?\//.test(ua) ? "Edge"
    : /CriOS|Chrome\//.test(ua) ? "Chrome"
      : /Firefox\//.test(ua) ? "Firefox"
        : /Safari\//.test(ua) ? "Safari"
          : "Browser";
  return `${platform} · ${browser}`;
}

function PairForm() {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("loading");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const claim = async (id: string, claimSecret: string): Promise<void> => {
      try {
        const response = await fetch("/api/public-access/pair/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, claimSecret }),
        });
        if (cancelled) return;
        if (response.status === 401) {
          setPhase("expired");
          return;
        }
        const body = await response.json().catch(() => ({})) as { status?: unknown };
        if (body.status === "approved") {
          setPhase("waiting");
          window.location.replace("/");
          return;
        }
        if (body.status === "rejected") {
          setPhase("rejected");
          return;
        }
        timer = setTimeout(() => { void claim(id, claimSecret); }, 2000);
      } catch {
        // 手机网络抖一下：2 秒后重试同一组凭据（凭据未被消耗）。
        if (!cancelled) timer = setTimeout(() => { void claim(id, claimSecret); }, 3000);
      }
    };

    const start = async (): Promise<void> => {
      const secret = new URLSearchParams(window.location.search).get("secret");
      if (!secret) {
        setPhase("expired");
        return;
      }
      try {
        const response = await fetch("/api/public-access/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret, name: deviceLabel() }),
        });
        if (cancelled) return;
        if (response.status === 401) {
          setPhase("expired");
          return;
        }
        if (response.status === 429) {
          setPhase("limit");
          return;
        }
        if (!response.ok) {
          setPhase("failed");
          return;
        }
        const body = await response.json() as { id?: unknown; claimSecret?: unknown };
        if (typeof body.id !== "string" || typeof body.claimSecret !== "string") {
          setPhase("failed");
          return;
        }
        setPhase("waiting");
        void claim(body.id, body.claimSecret);
      } catch {
        if (!cancelled) setPhase("failed");
      }
    };

    void start();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const message = (() => {
    switch (phase) {
      case "loading": return t("publicAccess.pair.loading");
      case "waiting": return t("publicAccess.pair.waiting");
      case "rejected": return t("publicAccess.pair.rejected");
      case "limit": return t("publicAccess.pair.limit");
      case "failed": return t("publicAccess.pair.failed");
      case "expired": return t("publicAccess.pair.expired");
    }
  })();

  return (
    <main className="web-login-page">
      <div className="web-login-shell">
        <header className="web-login-brand">
          <Image src="/icons/apple-touch-icon.png" width={52} height={52} alt="" priority />
          <div>
            <h1>Pi Web</h1>
            <p>{t("publicAccess.pair.title")}</p>
          </div>
        </header>
        <p className="public-access-pair-status" role="status" aria-live="polite">{message}</p>
        {phase === "waiting" && (
          <p className="public-access-pair-hint">{t("publicAccess.pair.hint")}</p>
        )}
      </div>
    </main>
  );
}

export default function PairPage() {
  return <I18nProvider><PairForm /></I18nProvider>;
}
