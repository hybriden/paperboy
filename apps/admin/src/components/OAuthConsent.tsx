import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { useUser } from "../lib/user.js";

/**
 * The MCP OAuth consent screen — the authorization endpoint (/oauth/authorize).
 *
 * An MCP client (Claude, Cursor, …) sends the user here with an authorization
 * request. They have already signed in with the admin's own login (App shows
 * the Login screen first), so this page only has to say who is asking, where
 * the answer goes, and which site the connection may reach. The server checks
 * the choice again: the picker only offers what the user may pick, but a forged
 * POST must not be able to widen it.
 */

/** The authorization-request parameters, forwarded verbatim to the API. */
const PARAMS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "resource", "scope"];

export function OAuthConsent() {
  const { user } = useUser();
  const search = new URLSearchParams(window.location.search);
  const params = Object.fromEntries(PARAMS.filter((k) => search.has(k)).map((k) => [k, search.get(k)!]));
  const query = new URLSearchParams(params).toString();

  const request = useQuery({ queryKey: ["oauth-request", query], queryFn: ({ signal }) => api.oauthRequest(query, signal), retry: false });
  const [site, setSite] = useState<string | null | undefined>(undefined); // null = every site
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const data = request.data;
  // A request that is wrong in a way the CLIENT should be told about goes back
  // to it (per RFC 6749) — never an unregistered redirect, which the API refuses.
  useEffect(() => {
    if (data && "errorRedirect" in data) window.location.assign(data.errorRedirect);
  }, [data]);

  const consent = data && "client" in data ? data : null;
  // Default to the site the user was last working in, when they may pick it.
  const chosen = site !== undefined ? site : consent && (consent.sites.find((s) => s.id === consent.activeSiteId)?.id ?? consent.sites[0]?.id ?? null);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      const { redirectTo } = await api.oauthDecide(params, approve, chosen ?? null);
      window.location.assign(redirectTo);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  let redirectHost = "";
  try {
    redirectHost = consent ? new URL(consent.client.redirectUri).host || consent.client.redirectUri : "";
  } catch {
    redirectHost = consent?.client.redirectUri ?? "";
  }

  return (
    <main className="grid min-h-full place-items-center bg-canvas px-6 py-10">
      <div className="w-full max-w-[440px] animate-fade-in">
        <div className="mb-8 flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-(--radius) bg-brand font-display text-lg font-semibold text-white">P</span>
          <span className="font-display text-2xl font-semibold tracking-[-0.01em]">Paperboy</span>
        </div>

        {request.isLoading && <p className="text-sm text-muted">Checking the request…</p>}

        {request.isError && (
          <p role="alert" className="rounded-(--radius) border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            This connection request can't be used: {(request.error as Error).message}
          </p>
        )}

        {consent && (
          <form
            aria-labelledby="consent-title"
            onSubmit={(e) => {
              e.preventDefault();
              void decide(true);
            }}
          >
            <h1 id="consent-title" className="text-2xl font-bold tracking-[-0.01em]">
              Connect <span className="text-brand">{consent.client.name}</span>?
            </h1>
            <p className="mb-6 mt-1.5 text-sm text-muted">
              It will act as <strong className="font-semibold text-fg">{user.name}</strong> ({user.email}), with your roles and permissions, and send
              its answer to <strong className="font-semibold text-fg">{redirectHost}</strong>.
            </p>

            {consent.sites.length === 0 ? (
              <p role="alert" className="mb-4 rounded-(--radius) border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                You don't have access to any site, so there is nothing to connect.
              </p>
            ) : (
              <fieldset className="mb-6">
                <legend className="field-label">Which site may it work in?</legend>
                <div className="mt-2 flex flex-col gap-2">
                  {consent.sites.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 rounded-(--radius) border border-line px-3 py-2 text-sm">
                      <input type="radio" name="site" checked={chosen === s.id} onChange={() => setSite(s.id)} />
                      <span>
                        {s.name} <span className="text-muted">({s.slug})</span>
                      </span>
                    </label>
                  ))}
                  {consent.allSitesAllowed && (
                    <label className="flex items-start gap-2 rounded-(--radius) border border-line px-3 py-2 text-sm">
                      <input type="radio" name="site" className="mt-1" checked={chosen === null} onChange={() => setSite(null)} />
                      <span>
                        Every site
                        <span className="block text-xs text-muted">
                          Including sites added later, and what every site shares — users, content types and the audit log, as far as your role allows.
                        </span>
                      </span>
                    </label>
                  )}
                </div>
              </fieldset>
            )}

            {error && (
              <p role="alert" className="mb-4 rounded-(--radius) border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <button type="submit" className="btn-primary h-11 grow text-[15px]" disabled={busy || consent.sites.length === 0}>
                Allow
              </button>
              <button type="button" className="btn-subtle h-11 px-5 text-[15px]" disabled={busy} onClick={() => void decide(false)}>
                Cancel
              </button>
            </div>
            <p className="mt-6 text-xs text-muted">You can disconnect it at any time in Settings → Connected apps.</p>
          </form>
        )}
      </div>
    </main>
  );
}
