import { useState } from "react";
import { api, setCsrf } from "../lib/api.js";
import type { SessionUser } from "@paperboy/shared";

type Step = "email" | "password" | "code";

export function Login({ onLogin }: { onLogin: (u: SessionUser) => void }) {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 2FA challenge.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState("");

  function finish(res: { user: SessionUser; csrfToken: string }) {
    setCsrf(res.csrfToken);
    onLogin(res.user);
  }
  function reset() {
    setStep("email");
    setPassword("");
    setCode("");
    setMfaToken(null);
    setError(null);
  }

  // Step 1 — email only. 2FA accounts go straight to the code (passwordless);
  // everyone else is asked for a password.
  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(email);
      if ("mfaRequired" in res) { setMfaToken(res.mfaToken); setStep("code"); }
      else if ("passwordRequired" in res) { setStep("password"); }
      else { finish(res); }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  // Step 2a — password (non-2FA accounts).
  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(email, password);
      if ("mfaRequired" in res) { setMfaToken(res.mfaToken); setStep("code"); }
      else if ("passwordRequired" in res) { setStep("password"); }
      else { finish(res); }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  // Step 2b — TOTP / backup code.
  async function submitMfa(e: React.FormEvent) {
    e.preventDefault();
    if (!mfaToken) return;
    setBusy(true);
    setError(null);
    try {
      finish(await api.loginMfa(mfaToken, code.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code");
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <div className="flex h-full items-center justify-center bg-chrome">{children}</div>
  );
  const Brand = (
    <div className="mb-6 flex items-center gap-2">
      <div className="grid h-9 w-9 place-items-center rounded bg-accent font-bold text-white">P</div>
      <div>
        <h1 className="text-lg font-bold leading-tight">Paperboy CMS</h1>
        <p className="text-xs text-muted">Sign in to the editor</p>
      </div>
    </div>
  );
  const Err = error && <p role="alert" className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;

  if (step === "code") {
    return (
      <Shell>
        <form onSubmit={submitMfa} className="w-[360px] rounded-lg bg-panel p-7 shadow-panel" aria-labelledby="mfa-title">
          <h1 id="mfa-title" className="text-lg font-bold leading-tight">Two-factor authentication</h1>
          <p className="mb-4 mt-1 text-xs text-muted">Signing in as <strong>{email}</strong>. Enter the 6-digit code from your authenticator app (or a backup code).</p>
          <label className="field-label" htmlFor="mfacode">Authentication code</label>
          <input id="mfacode" className="field-input mb-4 text-center font-mono tracking-[0.3em]" inputMode="text" autoFocus autoComplete="one-time-code"
            value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" required />
          {Err}
          <button type="submit" className="btn-primary w-full" disabled={busy || code.trim().length < 6}>{busy ? "Verifying…" : "Verify"}</button>
          <button type="button" className="mt-3 w-full text-center text-xs text-muted hover:text-fg" onClick={reset}>← Back to sign in</button>
        </form>
      </Shell>
    );
  }

  if (step === "password") {
    return (
      <Shell>
        <form onSubmit={submitPassword} className="w-[360px] rounded-lg bg-panel p-7 shadow-panel" aria-labelledby="login-title">
          {Brand}
          <p className="mb-4 text-xs text-muted">Signing in as <strong>{email}</strong></p>
          <label className="field-label" htmlFor="password">Password</label>
          <input id="password" className="field-input mb-4" type="password" value={password} autoFocus autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)} required />
          {Err}
          <button type="submit" className="btn-primary w-full" disabled={busy || !password}>{busy ? "Signing in…" : "Sign in"}</button>
          <button type="button" className="mt-3 w-full text-center text-xs text-muted hover:text-fg" onClick={reset}>← Use a different email</button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell>
      <form onSubmit={submitEmail} className="w-[360px] rounded-lg bg-panel p-7 shadow-panel" aria-labelledby="login-title">
        {Brand}
        <label className="field-label" htmlFor="email">Email</label>
        <input id="email" className="field-input mb-4" type="email" value={email} autoFocus autoComplete="username"
          onChange={(e) => setEmail(e.target.value)} required />
        {Err}
        <button type="submit" className="btn-primary w-full" disabled={busy || !email}>{busy ? "Continuing…" : "Continue"}</button>
        <p className="mt-4 text-center text-xs text-muted">
          2FA accounts sign in with a code; others continue to a password.
        </p>
      </form>
    </Shell>
  );
}
