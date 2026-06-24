import { useEffect, useRef, useState } from "react";
import { api, setCsrf } from "../lib/api.js";
import type { SessionUser } from "@paperboy/shared";

type Step = "email" | "password" | "code";

// Newspapers carry the date on the masthead. Computed once per mount.
function todayDateline(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function Login({ onLogin }: { onLogin: (u: SessionUser) => void }) {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 2FA challenge.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [dateline] = useState(todayDateline);

  // Focus the active step's input on mount / step change (replaces autoFocus).
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
    else if (step === "password") passwordRef.current?.focus();
    else emailRef.current?.focus();
  }, [step]);

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

  const errBanner = error && (
    <p role="alert" className="mb-4 rounded-[var(--radius)] border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
      {error}
    </p>
  );

  return (
    <div className="grid h-full grid-cols-1 bg-canvas md:grid-cols-[1.05fr_1fr]">
      {/* ── Editorial masthead — the front page. Always dark; reads in both themes. ── */}
      <aside
        className="relative hidden overflow-hidden border-chrome-border bg-chrome px-12 py-10 text-chrome-fg md:flex md:flex-col md:justify-between md:border-r"
        style={{
          // Faint newspaper column rules — ambient texture, not a divider.
          backgroundImage:
            "repeating-linear-gradient(90deg, rgb(var(--c-chrome-fg) / 0.035) 0 1px, transparent 1px 96px)",
        }}
      >
        {/* Dateline — tracked mono caps, with the one press-red brand mark. */}
        <div className="flex items-center gap-2.5 text-[11px] uppercase tracking-[0.22em] text-chrome-fg/70">
          <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px] bg-brand" aria-hidden="true" />
          <span>{dateline}</span>
        </div>

        {/* Masthead wordmark + motto. */}
        <div className="animate-slide-up">
          <div className="mb-4 border-t border-chrome-border pt-5 text-[11px] uppercase tracking-[0.3em] text-chrome-fg/65">
            The editor’s desk
          </div>
          <h1 className="font-display text-6xl font-semibold leading-[0.95] tracking-[-0.02em] lg:text-7xl">
            Paperboy
          </h1>
          <p className="mt-5 max-w-sm border-t border-chrome-border pt-5 font-display text-lg leading-snug text-chrome-fg/80">
            All the content that’s fit to publish.
          </p>
        </div>

        {/* Footer line. */}
        <div className="text-[11px] uppercase tracking-[0.22em] text-chrome-fg/65">
          Headless CMS · Newsroom edition
        </div>
      </aside>

      {/* ── Sign-in form ── */}
      <main className="flex items-center justify-center px-6 py-10">
        <div className="w-full max-w-[380px] animate-fade-in">
          {/* Compact wordmark for mobile, where the masthead panel is hidden. */}
          <div className="mb-8 flex items-center gap-2.5 md:hidden">
            <span className="grid h-9 w-9 place-items-center rounded-[var(--radius)] bg-brand font-display text-lg font-semibold text-white">P</span>
            <span className="font-display text-2xl font-semibold tracking-[-0.01em]">Paperboy</span>
          </div>

          {step === "email" && (
            <form onSubmit={submitEmail} aria-labelledby="login-title">
              <h2 id="login-title" className="text-2xl font-bold tracking-[-0.01em]">Sign in</h2>
              <p className="mb-7 mt-1.5 text-sm text-muted">Enter your email to continue to the editor.</p>
              <label className="field-label" htmlFor="email">Email</label>
              <input
                id="email" ref={emailRef} aria-label="Email" type="email" autoComplete="username"
                className="field-input mb-5" value={email} onChange={(e) => setEmail(e.target.value)} required
              />
              {errBanner}
              <button type="submit" className="btn-primary h-11 w-full text-[15px]" disabled={busy || !email}>
                {busy ? "Continuing…" : "Continue"}
              </button>
              <p className="mt-6 text-center text-xs text-muted">
                Accounts with two-factor sign in with a code; others continue to a password.
              </p>
            </form>
          )}

          {step === "password" && (
            <form onSubmit={submitPassword} aria-labelledby="login-title">
              <h2 id="login-title" className="text-2xl font-bold tracking-[-0.01em]">Enter your password</h2>
              <p className="mb-7 mt-1.5 text-sm text-muted">Signing in as <strong className="font-semibold text-fg">{email}</strong></p>
              <label className="field-label" htmlFor="password">Password</label>
              <input
                id="password" ref={passwordRef} aria-label="Password" type="password" autoComplete="current-password"
                className="field-input mb-5" value={password} onChange={(e) => setPassword(e.target.value)} required
              />
              {errBanner}
              <button type="submit" className="btn-primary h-11 w-full text-[15px]" disabled={busy || !password}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
              <button type="button" className="mt-3 w-full rounded-[var(--radius)] py-1.5 text-center text-xs text-muted transition-colors hover:text-fg" onClick={reset}>
                ← Use a different email
              </button>
            </form>
          )}

          {step === "code" && (
            <form onSubmit={submitMfa} aria-labelledby="mfa-title">
              <h2 id="mfa-title" className="text-2xl font-bold tracking-[-0.01em]">Two-factor authentication</h2>
              <p className="mb-7 mt-1.5 text-sm text-muted">
                Signing in as <strong className="font-semibold text-fg">{email}</strong>. Enter the 6-digit code from your authenticator app, or a backup code.
              </p>
              <label className="field-label" htmlFor="mfacode">Authentication code</label>
              <input
                id="mfacode" ref={codeRef} aria-label="Authentication code" inputMode="text" autoComplete="one-time-code"
                className="field-input mb-5 text-center font-mono text-lg tracking-[0.4em]"
                value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" required
              />
              {errBanner}
              <button type="submit" className="btn-primary h-11 w-full text-[15px]" disabled={busy || code.trim().length < 6}>
                {busy ? "Verifying…" : "Verify"}
              </button>
              <button type="button" className="mt-3 w-full rounded-[var(--radius)] py-1.5 text-center text-xs text-muted transition-colors hover:text-fg" onClick={reset}>
                ← Back to sign in
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
