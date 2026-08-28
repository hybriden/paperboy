---
name: web-platform-security
description: "Audit browser-enforced security primitives every web app depends on: CORS, Content Security Policy (CSP with nonces and Trusted Types), cross-origin isolation (COOP/COEP/CORP), modern cookies (SameSite, __Host- prefix, CHIPS Partitioned), Permissions-Policy, Subresource Integrity, HSTS, Referrer-Policy, iframe sandboxing, postMessage origin checks, Private Network Access (PNA), WebAuthn/Passkeys, and FedCM. Sourced from web.dev, developer.chrome.com, and the Fetch/HTML/Cookies/WebAuthn specs. Use when the user asks about security headers, CORS, CSP design, secure cookies, cross-origin isolation, SharedArrayBuffer requirements, clickjacking, mixed content, HSTS preload, sandboxed iframes, passkeys, FedCM, PNA, partitioned cookies, or 'audit my browser security'. Triggers: 'review my CSP', 'audit my CORS', 'are my cookies safe', 'enable cross-origin isolation', 'set up Trusted Types', 'WebAuthn integration', 'CHIPS cookies'. Use even when only one primitive is mentioned."
---

# Web Platform Security

Audit the browser-enforced security primitives that every web app depends on, regardless of framework. These are the controls the browser itself implements — getting them right makes entire vulnerability classes (XSS impact, clickjacking, CSRF, third-party data exfiltration, cross-origin data leaks) much harder to exploit.

The skill is grounded in first-party sources: web.dev articles, developer.chrome.com, the Fetch / HTML / Cookies / WebAuthn specs, and Chromium intent-to-ship records. When upstream guidance changes (e.g., Chrome rolls out Private Network Access enforcement, CHIPS partitioned cookies graduate from origin trial), this skill's checks update before the next scheduled review.

## When this skill applies

- Reviewing HTTP response headers on a deployed web app
- Designing or hardening a Content Security Policy
- Auditing cookie attributes for session, CSRF, and tracking cookies
- Enabling cross-origin isolation to use `SharedArrayBuffer`, high-resolution `performance.now()`, or `Cross-Origin-Embedder-Policy: require-corp`
- Replacing third-party-cookie SSO with FedCM
- Integrating WebAuthn / passkeys
- Preparing for Chrome's Private Network Access enforcement (preflight from public to private IPs)
- Migrating to CHIPS (Partitioned cookies) for cross-site embedded contexts

Use other skills for:
- App-layer XSS sink review → `react-security`, `vue-nuxt-security`, etc., or `saas-code-security-review`
- Framework-specific header injection patterns → `nextjs-security`, `svelte-sveltekit-security`, etc.
- API rate limiting and webhook signatures → `saas-api-security`
- Server-side TLS / certificate config → `iac-container-security`

This skill is the deep-dive platform reference; the others can defer to it for browser primitives.

## Workflow

Follow `../_shared/audit-workflow.md`. Web-platform-specific notes below.

### Phase 1: Scope confirmation

- Production domain(s) and any preview/staging origins (CSP allowlist will need them)
- Embedded contexts: does the app appear in iframes elsewhere? Do you embed third-party iframes?
- Auth model: cookie-based session, Bearer token, OAuth via redirect, OIDC via iframe, WebAuthn?
- Browser baseline: evergreen-only, or do you support Safari ≤ 15, Firefox ESR, etc.? (Affects which features can be required.)

### Phase 2: Inventory

```bash
# Headers on a representative URL
curl -sIL -H 'Accept: text/html' https://app.example.com/ \
  | grep -iE 'content-security-policy|strict-transport-security|x-frame-options|x-content-type-options|referrer-policy|permissions-policy|cross-origin-opener-policy|cross-origin-embedder-policy|cross-origin-resource-policy|set-cookie|x-permitted-cross-domain-policies'

# CORS surface for an API endpoint
curl -sI -X OPTIONS \
  -H 'Origin: https://probe.example' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,authorization' \
  https://api.example.com/v1/users

# Cookies issued at login (use a real test account)
curl -sI -c - https://app.example.com/login -d 'email=...&password=...' \
  | grep -i set-cookie
```

External evaluators worth running:
- https://csp-evaluator.withgoogle.com — paste the CSP, see weaknesses
- https://securityheaders.com — overall grade
- https://hstspreload.org — HSTS preload eligibility
- Chrome DevTools → **Application → Frames → top → Security** — shows cross-origin isolation state, COOP/COEP report-only violations, cookie audit

### Phase 3: Detection — the checks

#### CORS — see `references/cors-and-pna.md`

- **WPS-CORS-1** `Access-Control-Allow-Origin` uses an explicit origin allowlist, never reflects the `Origin` header without validating it against a literal list.
- **WPS-CORS-2** `Access-Control-Allow-Origin: *` is never paired with `Access-Control-Allow-Credentials: true` (browsers reject the combination, but the intent is the smell).
- **WPS-CORS-3** `Vary: Origin` is set on any response that varies CORS headers — required for correct CDN caching.
- **WPS-CORS-4** `Access-Control-Allow-Methods` and `Access-Control-Allow-Headers` are explicit lists, not `*`, when credentials are involved.
- **WPS-CORS-5** Preflight responses (`OPTIONS`) return 204 with appropriate headers and `Access-Control-Max-Age` (1h–24h is reasonable).
- **WPS-CORS-6** Wildcard subdomain matching (`*.example.com`) is implemented as a hostname suffix check on a parsed URL, not a regex that allows `evil-example.com`.
- **WPS-CORS-7** Private Network Access: any request from a `public` page (https or http on a routable address) to a `private` IP (RFC1918, link-local) sends `Access-Control-Request-Private-Network: true` on preflight and the server returns `Access-Control-Allow-Private-Network: true` only when intentional. Chrome enforces this; failing to handle it breaks LAN-targeted apps.

#### Content Security Policy — see `references/csp-and-trusted-types.md`

- **WPS-CSP-1** `Content-Security-Policy` header is present and **enforcing** (not just `Content-Security-Policy-Report-Only`).
- **WPS-CSP-2** `script-src` uses nonces (`'nonce-…'`) with `'strict-dynamic'`, or hashes for static apps. No `'unsafe-inline'` and no `'unsafe-eval'` (or each documented with rationale).
- **WPS-CSP-3** No wildcard hosts in `script-src` or `object-src` (`*`, `https:`).
- **WPS-CSP-4** `object-src 'none'` and `base-uri 'none'` (or `'self'`) — closes two common XSS bypass vectors.
- **WPS-CSP-5** `frame-ancestors 'self'` (or specific allowed embedders) — replaces `X-Frame-Options` and prevents clickjacking.
- **WPS-CSP-6** `form-action 'self'` (or specific) prevents form-submission hijacking via injected `<form action="…">`.
- **WPS-CSP-7** `upgrade-insecure-requests` is present so subresource HTTP URLs are upgraded to HTTPS.
- **WPS-CSP-8** `report-uri` or `report-to` is configured AND the receiving endpoint is monitored (an unmonitored report endpoint catches nothing).
- **WPS-CSP-9** Trusted Types: `require-trusted-types-for 'script'` and `trusted-types <policy-name>` are set on apps that use DOM sinks. Converts DOM XSS from a runtime bug into a thrown error.
- **WPS-CSP-10** The same enforcing policy is applied to every HTML response (middleware/edge), not per-route ad-hoc.

#### Cross-Origin isolation — see `references/cross-origin-isolation.md`

- **WPS-COOP-1** `Cross-Origin-Opener-Policy: same-origin` (or `same-origin-allow-popups` if you intentionally open cross-origin popups) — severs the opener relationship for cross-origin navigations, preventing tabnabbing and cross-origin window manipulation.
- **WPS-COEP-1** `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless` when you embed cross-origin resources you can't control) — required to be "cross-origin isolated" (gates `SharedArrayBuffer`, high-resolution timers, `performance.measureUserAgentSpecificMemory()`).
- **WPS-CORP-1** API responses set `Cross-Origin-Resource-Policy: same-origin` (or `same-site`) to opt out of cross-origin embedding by attacker pages.
- **WPS-ISO-1** Pages that need cross-origin isolation actually achieve it (verify `crossOriginIsolated === true` in console). COEP without COOP doesn't isolate.

#### Cookies — see `references/cookies-modern.md`

- **WPS-COOK-1** Session cookies set `HttpOnly` (JS cannot read), `Secure` (HTTPS only), and `SameSite=Lax` (or `Strict` for high-value sessions).
- **WPS-COOK-2** Session cookies use the `__Host-` prefix when scoping permits: requires `Secure`, no `Domain` attribute, `Path=/`. Subdomain takeover cannot read or replace.
- **WPS-COOK-3** Sensitive cookies use the `__Secure-` prefix at minimum (browser enforces `Secure` flag).
- **WPS-COOK-4** No long-lived authentication cookies (access cookie ≤ 1h; pair with rotated refresh).
- **WPS-COOK-5** Logout invalidates session server-side, not just clears the cookie.
- **WPS-COOK-6** Cross-site embedded contexts use `Partitioned` (CHIPS) cookies — per-top-level-site cookie jars. Avoid `SameSite=None` without `Partitioned` when third-party cookies are being phased out.
- **WPS-COOK-7** Cookies with sensitive data never use a wider `Domain=.example.com` than necessary.

#### Permissions Policy

- **WPS-PP-1** `Permissions-Policy` header denies powerful features not used by the app: `camera=()`, `microphone=()`, `geolocation=()`, `payment=()`, `usb=()`, `bluetooth=()`, `serial=()`, `accelerometer=()`, `gyroscope=()`, `magnetometer=()`, `xr-spatial-tracking=()`.
- **WPS-PP-2** Features the app DOES use are scoped to the origin: `geolocation=(self)`, not `geolocation=*`.
- **WPS-PP-3** Iframes carrying user content set `allow=""` (empty) to drop all delegated permissions.

#### Subresource Integrity (SRI)

- **WPS-SRI-1** Every `<script>` and `<link rel="stylesheet">` loaded from a third-party CDN (cdnjs, unpkg, jsdelivr) includes `integrity="sha384-..."` and `crossorigin="anonymous"`.
- **WPS-SRI-2** First-party scripts loaded from your own CDN do not require SRI (you control them) but it's a defense-in-depth.
- **WPS-SRI-3** Tag managers (GTM) that inject third-party scripts cannot retrofit SRI — restrict GTM tag inventory via tag manager permissions instead.

#### Mixed content + HSTS

- **WPS-HST-1** `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` on production HTTPS responses; the apex domain is submitted to https://hstspreload.org.
- **WPS-HST-2** No mixed content: every subresource (`<img>`, `<script>`, `<link>`, `fetch()`) loaded over HTTPS. CSP `upgrade-insecure-requests` catches stragglers.
- **WPS-HST-3** `X-Content-Type-Options: nosniff` is set on all responses to prevent MIME sniffing.

#### Referrer Policy

- **WPS-REF-1** `Referrer-Policy: strict-origin-when-cross-origin` (default in modern browsers) or stricter. Avoid `no-referrer-when-downgrade` (default in old browsers) and `unsafe-url`.
- **WPS-REF-2** Pages that handle tokens in URL fragments / query string set `Referrer-Policy: no-referrer` to avoid leaking via `Referer` header.

#### postMessage / cross-frame trust

- **WPS-PM-1** Every `window.addEventListener('message', …)` handler validates `event.origin` against an allowlist before reading `event.data`.
- **WPS-PM-2** `postMessage(message, targetOrigin)` calls use a specific origin, not `'*'`, when the payload contains anything sensitive.
- **WPS-PM-3** Message handlers validate the payload shape (schema check) before dispatching to business logic.
- **WPS-PM-4** Iframes hosting third-party content set the `sandbox` attribute restricting capabilities (`sandbox="allow-scripts allow-same-origin"` is the minimum useful; weigh removing `allow-same-origin`).

#### Modern authentication

- **WPS-AUTH-1** WebAuthn / Passkeys: discoverable credentials registered with `residentKey: required` and `userVerification: required` for passwordless flows. The relying-party ID matches the eTLD+1 of the production domain.
- **WPS-AUTH-2** FedCM (`navigator.credentials.get({identity: …})`) used in place of third-party-cookie SSO flows where applicable. IDP configuration is fetched from `/.well-known/web-identity` and the IDP serves the FedCM config.
- **WPS-AUTH-3** Origin-bound one-time codes (`@bound: <origin>`) used in SMS-OTP flows to prevent cross-origin code phishing.

#### Service Worker

- **WPS-SW-1** Service worker scope is the narrowest path that works (declared via `Service-Worker-Allowed` header if needed) — not the entire site root by accident.
- **WPS-SW-2** Service worker does not cache responses with `Authorization` headers or user-specific data unless cache-keying includes the user identity.
- **WPS-SW-3** Service worker source is served with `Cache-Control` allowing updates within minutes, not days.
- **WPS-SW-4** A registered service worker can be unregistered remotely if compromised (kill-switch).

### Phase 4: Triage

Critical class examples for this skill:
- No CSP at all on the production app, or `script-src 'unsafe-inline' 'unsafe-eval' *`
- Session cookie without `HttpOnly` (XSS = session steal)
- CORS reflects `Origin` with `Allow-Credentials: true` (cross-site exfiltration of authenticated responses)
- No HSTS on production HTTPS (network attacker downgrade)
- Open redirect in auth callback

High class:
- COOP missing on a page that uses popup-based OAuth (tabnabbing)
- COEP missing on a page expecting cross-origin isolation
- Third-party scripts from public CDN with no SRI
- `frame-ancestors` allows attacker origins

### Phase 5: Report

Use `../_shared/findings-schema.md`. Prefix IDs with `WPS-` (Web Platform Security). The granular category sub-prefixes (`WPS-CORS-3`, `WPS-CSP-9`, etc.) shown above are recommended for cross-report aggregation.

## Outputs

1. Markdown audit report following the unified findings schema.
2. (Optional) A drop-in `headers.conf` / middleware snippet for the user's edge / framework that sets the recommended headers.
3. (Optional) A CSP rollout plan — start in `Report-Only`, observe for 1-2 weeks, switch to enforcing, then tighten.

## References

- `references/cors-and-pna.md` — CORS allowlist patterns, credentials gotchas, subdomain wildcards, Private Network Access preflight (sourced from web.dev, Fetch spec, Chrome PNA intent-to-ship)
- `references/csp-and-trusted-types.md` — Strict CSP design, nonce vs hash, `strict-dynamic`, Trusted Types policies, report endpoint hygiene (sourced from web.dev Strict CSP guide, W3C CSP3 / Trusted Types specs)
- `references/cross-origin-isolation.md` — COOP / COEP / CORP, `credentialless`, why isolation gates `SharedArrayBuffer`, debugging report-only rollout (sourced from web.dev Cross-Origin Isolation, developer.chrome.com)
- `references/cookies-modern.md` — `SameSite`, `__Host-` / `__Secure-` prefixes, CHIPS Partitioned cookies, the Lax-by-default migration, third-party cookie phase-out (sourced from web.dev, RFC 6265bis)

## Source attribution

Authoritative sources for this skill:

- **web.dev** (Google's web platform docs)
- **developer.chrome.com** (Chrome team posts, intent-to-ship)
- **WHATWG Fetch spec** (CORS, preflight)
- **W3C CSP3, Trusted Types, Permissions Policy** specs
- **RFC 6265bis** (cookies)
- **W3C WebAuthn Level 3** and **FedCM** working drafts
- **Chrome status entries** for newly-shipped features (PNA, CHIPS)

When upstream guidance changes (e.g., browser default flips, spec stabilizes a new header), update the relevant check above and bump `last_verified` in `.github/tech-inventory.yml` for the corresponding entry.
