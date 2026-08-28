# Modern Cookies: SameSite, Prefixes, CHIPS Partitioned

Authoritative sources:
- web.dev — [SameSite cookies explained](https://web.dev/articles/samesite-cookies-explained)
- web.dev — [Schemeful Same-Site](https://web.dev/articles/schemeful-samesite)
- web.dev — [Cookies Having Independent Partitioned State (CHIPS)](https://developers.google.com/privacy-sandbox/cookies/chips)
- web.dev — [Prepare for third-party cookie restrictions](https://developers.google.com/privacy-sandbox/cookies)
- RFC 6265bis — [HTTP State Management Mechanism](https://datatracker.ietf.org/doc/draft-ietf-httpbis-rfc6265bis/)

## The attributes that matter

| Attribute | Purpose | When to use |
|-----------|---------|-------------|
| `HttpOnly` | JS cannot read the cookie | Always for session/auth |
| `Secure` | Sent only over HTTPS | Always in production |
| `SameSite=Lax` | Sent on top-level GET to your site, blocked on most cross-site | Default for most sessions |
| `SameSite=Strict` | Never sent on cross-site (including top-level GET) | High-value sessions |
| `SameSite=None` | Sent on all cross-site (requires `Secure`) | Third-party embeds, OAuth |
| `Path=/...` | Cookie only sent for matching paths | Scope narrow when possible |
| `Domain=...` | Cookie sent to subdomains | Only when needed |
| `__Secure-` prefix | Browser rejects if no `Secure` flag | Defense-in-depth |
| `__Host-` prefix | Browser rejects unless `Secure` + `Path=/` + no `Domain` | Strongest scoping |
| `Max-Age` / `Expires` | Persist beyond session | Refresh tokens |
| `Partitioned` (CHIPS) | Per-top-level-site cookie jar | Cross-site embedded |

## Recommended session cookie

```http
Set-Cookie: __Host-session=opaque-random-256-bit-value;
            HttpOnly;
            Secure;
            SameSite=Lax;
            Path=/;
            Max-Age=3600
```

Each line earns its place:
- `__Host-` prefix — browser enforces no `Domain`, `Path=/`, `Secure`. A compromised subdomain cannot read or replace this cookie.
- `HttpOnly` — JS cannot read; XSS no longer steals sessions directly.
- `Secure` — never sent over HTTP; network attacker cannot capture.
- `SameSite=Lax` — cross-site POSTs and iframes don't carry the cookie; CSRF largely mitigated.
- `Path=/` — required by `__Host-` prefix.
- `Max-Age=3600` — short access; pair with refresh.

## SameSite specifics

### Lax-by-default

Since Chrome 80 (and others followed), cookies without `SameSite` default to `Lax`. Practical implications:
- Cross-origin POST/PUT/DELETE/PATCH do NOT send the cookie.
- Cross-origin iframes do NOT send the cookie.
- Top-level GET TO your site DOES send the cookie (user clicking an external link still arrives logged in).

For most apps, `Lax` is the right answer. Combine with a CSRF token for additional defense against the residual GET-based CSRF risk.

### Strict trade-offs

`Strict` blocks even top-level GET. A user clicking a link to `https://app.example.com/dashboard` from email arrives logged out.

Use cases:
- High-value sessions where re-auth on entry is acceptable.
- Pair with a "browser-aware login" UX (silently redirect to login + back to original URL).

### None — when actually needed

Required for:
- Third-party iframes that need authenticated cookies (some support widgets, analytics).
- OAuth flows where the IDP redirects back via a top-level navigation that requires the cookie (rare with modern PKCE flows).

With `SameSite=None`, pair with:
- `Secure` (required by spec).
- Short expiry.
- CSRF tokens.
- Where possible, `Partitioned` (CHIPS) so cookies don't enable cross-site tracking.

### Schemeful Same-Site

`https://example.com` and `http://example.com` count as cross-site (different schemes). A cookie set on `https://` is NOT sent on `http://` even though the host matches. Generally good — forces HTTPS — but breaks dev setups that mix schemes.

## The prefix system

### `__Secure-` prefix

```http
Set-Cookie: __Secure-foo=bar; Secure; SameSite=Lax; Path=/
```

Browser rejects if `Secure` is missing. Defense-in-depth — guarantees the cookie can't accidentally be set over HTTP.

### `__Host-` prefix

```http
Set-Cookie: __Host-session=value; Secure; Path=/; SameSite=Lax; HttpOnly
```

Browser rejects if ANY of:
- `Secure` is missing
- `Path` is not exactly `/`
- `Domain` attribute is present

The cookie is valid only for the exact origin (no subdomains can read or write). For session cookies on a single-origin app, this is the strongest scoping.

## CHIPS — Partitioned cookies

Background: browsers are phasing out third-party (cross-site) cookies. A site embedded in many contexts (a support chat iframe, an SSO iframe, a payment widget) used to set ONE cookie that followed the user everywhere — useful for the legitimate vendor, but also the foundation of cross-site tracking.

CHIPS — "Cookies Having Independent Partitioned State" — gives the embedded site a SEPARATE cookie jar per top-level site. The embedded site sees the same cookie name across visits to the same top-level site, but each top-level site has its own jar.

### Setting a Partitioned cookie

```http
Set-Cookie: __Host-chat-session=value;
            HttpOnly; Secure; SameSite=None;
            Path=/; Partitioned
```

Required:
- `Secure`
- `SameSite=None` (it's cross-site by definition; otherwise it wouldn't need partitioning)
- `Partitioned` attribute

The browser stores this cookie keyed by `(top-level-site, embedded-site)`. When the embedded site loads on a different top-level site, it gets a separate cookie.

### When to use CHIPS

If you operate an embedded SaaS (support chat, comment widget, embedded form, embedded video player, SSO/iframe-based auth):
- Issue partitioned cookies for per-top-level-site state.
- Don't try to track the user across top-level sites with the cookie.
- Migrate any "remember me across sites" logic to a different mechanism (server-side mapping, FedCM for auth).

### When NOT to use CHIPS

For a first-party app's own session cookie (your `app.example.com` site setting cookies on its own domain), don't use `Partitioned`. First-party cookies are not affected by third-party cookie restrictions.

## Multi-cookie auth pattern

A common modern pattern: short access cookie + longer refresh cookie scoped to the refresh endpoint.

```http
Set-Cookie: __Host-access=<short-jwt-or-opaque>;
            HttpOnly; Secure; SameSite=Lax;
            Path=/; Max-Age=900

Set-Cookie: __Host-refresh=<opaque>;
            HttpOnly; Secure; SameSite=Strict;
            Path=/auth/refresh; Max-Age=2592000
```

- Refresh is `Strict` and scoped to `/auth/refresh` — only sent on refresh calls.
- Refresh has a longer lifetime; access is short.
- Both `__Host-` prefixed.

## Anti-patterns

### Anti-pattern A — Session in `localStorage`

```js
localStorage.setItem('jwt', token);  // readable by any script
```

Any XSS reads `localStorage`. Use a `HttpOnly` cookie. The "easier for SPAs" argument is an XSS-amplification argument.

### Anti-pattern B — Session cookie without `HttpOnly`

The cookie set on the response is fine, but if the auth library forgot the flag, JS can read it. Easy to miss in pre-2018 frameworks.

### Anti-pattern C — Unnecessary `Domain=...example.com`

```http
Set-Cookie: session=...; Domain=.example.com
```

If only `app.example.com` needs the cookie, don't set `Domain` at all (default is host-only). Any subdomain (legitimate or compromised) can otherwise read it.

### Anti-pattern D — Long-lived access tokens

`Max-Age=2592000` (30 days) on the access cookie. If leaked, the attacker has a month. Keep access short.

### Anti-pattern E — No server-side invalidation on logout

```js
res.clearCookie('session');
// The JWT inside is still valid until expiry
```

Logout must invalidate server-side: a session table where you delete the row; or a "tokens issued before timestamp X" rule per user. JWT alone with no revocation list is not a logout primitive.

### Anti-pattern F — Cookies in error reports

Sentry / Datadog / Rollbar can include request headers in error reports. If `Cookie` is included, sessions leak to the error tracking provider.

Configure error reporting to strip `Cookie`, `Authorization`, `X-CSRF-Token` headers. Every SDK has an option.

## Verifying

```bash
# Pull cookies issued at login
curl -sI -c - https://app.example.com/login \
  -d 'email=test@example.com&password=...' \
  | grep -i set-cookie
```

In DevTools:
- Application → Cookies → click each cookie.
- Confirm `HttpOnly`, `Secure`, `SameSite` columns match intent.
- `Domain` field should be empty (host-only) unless you genuinely need subdomain access.
- Console: `document.cookie` should NOT show any `HttpOnly` cookie.

## Audit checklist

For each cookie set:

1. `HttpOnly` if it's a session/auth cookie.
2. `Secure` in production.
3. `SameSite` value matches use case (Lax / Strict / None).
4. Scoped tightly — narrow `Path`, no unnecessary `Domain`.
5. Prefixed with `__Host-` (preferred) or `__Secure-` where applicable.
6. `Max-Age` appropriate to sensitivity.
7. Server-side invalidation on logout / password change / suspicious activity.
8. Cross-site embedded contexts use `Partitioned` (CHIPS).
9. Stripped from error reports.
10. Never written into `localStorage` / `sessionStorage` for auth tokens.
