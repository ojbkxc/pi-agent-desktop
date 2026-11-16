"use client";

import Image from "next/image";
import { useEffect, useState, type FormEvent } from "react";
import { I18nProvider, useI18n } from "@/hooks/useI18n";
import { safeLoginDestination } from "@/lib/login-destination";

function safeDestination(): string {
  const destination = new URLSearchParams(window.location.search).get("next");
  return safeLoginDestination(destination, window.location.origin);
}

type Mode = "loading" | "signin" | "setup";

function LoginForm() {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("loading");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // No password configured yet → this page doubles as the first-time setup form.
  // Only reachable locally: a public tunnel without a password is refused before
  // it gets here, and the setup route itself is isLocalRequest-only.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/web-auth", { headers: { Accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { enabled?: boolean } | null) => {
        if (cancelled) return;
        setMode(data && data.enabled === false ? "setup" : "signin");
      })
      .catch(() => { if (!cancelled) setMode("signin"); });
    return () => { cancelled = true; };
  }, []);

  const failureMessage = async (response: Response): Promise<string> => {
    if (response.status === 401) return t("auth.invalidPassword");
    if (response.status === 403) return t("authSetup.localOnly");
    if (response.status !== 429) return t("auth.loginFailed");
    const seconds = Number(response.headers.get("retry-after"));
    return t("auth.tooManyAttempts", { seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 1 });
  };

  const signIn = async () => {
    const response = await fetch("/api/web-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) {
      setError(await failureMessage(response));
      return;
    }
    window.location.replace(safeDestination());
  };

  const setUp = async () => {
    if (password !== confirm) {
      setError(t("authSetup.mismatch"));
      return;
    }
    // PUT stores the password and signs this browser in on success.
    const response = await fetch("/api/web-auth/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: password }),
    });
    if (!response.ok) {
      setError(response.status === 403 ? t("authSetup.localOnly") : t("authSetup.failed"));
      return;
    }
    window.location.replace(safeDestination());
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "setup") await setUp();
      else await signIn();
    } catch {
      setError(mode === "setup" ? t("authSetup.failed") : t("auth.loginFailed"));
    } finally {
      setBusy(false);
    }
  };

  const settingUp = mode === "setup";
  const canSubmit = !busy && password.length > 0 && (!settingUp || confirm.length > 0);

  return (
    <main className="web-login-page">
      <div className="web-login-shell">
        <header className="web-login-brand">
          <Image src="/icons/apple-touch-icon.png" width={52} height={52} alt="" priority />
          <div>
            <h1>Pi Web</h1>
            <p>{settingUp ? t("authSetup.prompt") : t("auth.prompt")}</p>
          </div>
        </header>
        <form className="web-login-form" onSubmit={submit}>
          <div className="web-login-composer">
            <label className="web-login-label" htmlFor="web-login-password">
              {settingUp ? t("authSetup.title") : t("auth.password")}
            </label>
            <input
              id="web-login-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("auth.password")}
              autoComplete={settingUp ? "new-password" : "current-password"}
              autoFocus
              required
              disabled={busy}
            />
            {settingUp && (
              <input
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                placeholder={t("authSetup.confirm")}
                autoComplete="new-password"
                required
                disabled={busy}
                aria-label={t("authSetup.confirm")}
              />
            )}
            <button type="submit" disabled={!canSubmit}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="2" y1="7" x2="11" y2="7" />
                <polyline points="7.5 3 12 7 7.5 11" />
              </svg>
              {busy
                ? t("auth.loggingIn")
                : (settingUp ? t("authSetup.submit") : t("auth.logIn"))}
            </button>
          </div>
          <p className="web-login-error" role="alert" aria-live="polite">{error}</p>
        </form>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return <I18nProvider><LoginForm /></I18nProvider>;
}
