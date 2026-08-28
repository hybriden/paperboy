# CSP and Trusted Types — Deep Dive

Authoritative sources:
- web.dev — [Strict Content Security Policy](https://web.dev/articles/strict-csp)
- web.dev — [Prevent DOM-based XSS with Trusted Types](https://web.dev/articles/trusted-types)
- W3C — [Content Security Policy Level 3](https://www.w3.org/TR/CSP3/)
- W3C — [Trusted Types](https://www.w3.org/TR/trusted-types/)
- Tool — https://csp-evaluator.withgoogle.com

## What CSP does

CSP is a browser-enforced policy declaring:
- Which scripts may execute (the most important directive)
- Which resources (styles, images, fonts, frames) may load
- Where the page may send data (`connect-src`)
- Whether/how the page may be framed
- Whether DOM sinks must accept a TrustedHTML object instead of a string

CSP doesn't prevent XSS bugs from existing. It prevents them from being *exploited successfully*. Combined with input handling and Trusted Types, it pushes DOM XSS from "happens regularly" to "very hard."

## Strict CSP — the modern recommended approach

The web.dev Strict CSP guide is the canonical pattern. Two flavors.

### Nonce-based (server-rendered apps)

Every HTML response gets a fresh random nonce. Every `<script>` tag includes the nonce.

```html
<script nonce="r4nd0m-per-request">/* inline */</script>
<script src="/app.js" nonce="r4nd0m-per-request"></script>
```

CSP header:

```
Content-Security-Policy:
  script-src 'nonce-r4nd0m-per-request' 'strict-dynamic';
  object-src 'none';
  base-uri 'none';
  frame-ancestors 'none';
  require-trusted-types-for 'script';
  report-uri /csp-report;
```

Why each piece:
- `'nonce-…'` — only scripts with this exact nonce run.
- `'strict-dynamic'` — a nonced script can dynamically load further scripts without you needing to allowlist their hosts. Lets bundlers, lazy loaders, and chunk loaders work.
- `object-src 'none'` — blocks `<object>` / Flash / applet legacy.
- `base-uri 'none'` — prevents `<base href="https://attacker">` from rerouting relative URLs.
- `frame-ancestors 'none'` — replaces `X-Frame-Options: DENY`.
- `require-trusted-types-for 'script'` — see Trusted Types section below.
- `report-uri` — kept during rollout to catch regressions.

Server generates nonce per request (CSPRNG, 128 bits, base64-encoded). Passes to template engine. Template injects into each `<script>` tag.

### Hash-based (fully static apps)

For sites without server-side rendering:

```
script-src 'sha256-Q5...' 'sha256-X8...';
```

Compute each inline script's SHA-256 at build time. Any edit changes the hash. Works well for stable inline scripts.

## Rollout in three phases

### Phase 1 — Observation (report-only)

```
Content-Security-Policy-Report-Only:
  script-src 'self';
  object-src 'none';
  base-uri 'none';
  report-uri /csp-report;
```

Doesn't block; reports violations. Run 1-2 weeks. Identify legitimate sources you need to add.

### Phase 2 — Strict CSP (enforcing)

```
Content-Security-Policy:
  script-src 'nonce-{NONCE}' 'strict-dynamic';
  object-src 'none';
  base-uri 'none';
  frame-ancestors 'self';
  upgrade-insecure-requests;
  report-uri /csp-report;
```

Switch from `Report-Only` to enforcing. Keep `report-uri` to catch regressions.

### Phase 3 — Tighten

- Remove `'unsafe-eval'` if still present (refactor any code that needs it; modern frameworks don't).
- Add `require-trusted-types-for 'script'`.
- Restrict `connect-src` to known API hosts.
- Restrict `img-src`, `style-src`, `font-src` to specific origins.
- Test on every supported browser cohort.

## Common CSP mistakes

### Mistake 1 — `'unsafe-inline'` everywhere

Defeats CSP's main purpose. The most common cause: inline event handlers (`onclick="…"`) in legacy code. Fix by moving to `addEventListener` in nonced/external scripts.

### Mistake 2 — `script-src 'self'` only

`'self'` allows scripts from the same origin. If user uploads are served from the same origin and a content-type can be set to JavaScript (or HTML containing a script), the upload becomes executable. Either:
- Host uploads on a separate origin (subdomain on a different eTLD+1, or use a non-script Content-Type with `Content-Disposition: attachment`).
- Set `X-Content-Type-Options: nosniff` on the upload server.

### Mistake 3 — Allowlisting risky origins

`script-src 'self' https://cdn.jsdelivr.net` — anyone who publishes a package on jsdelivr can execute on your site. Allowlists in CSP are weaker than nonces. The web.dev recommendation is: prefer nonces + `'strict-dynamic'`, not allowlists.

### Mistake 4 — Forgetting `object-src` and `base-uri`

Both are common XSS bypass vectors and both must be explicitly closed:
- `<object data="…">` can execute Flash/applet legacy
- `<base href="https://attacker.com/">` reroutes all relative URLs

### Mistake 5 — `frame-ancestors *`

Allows anyone to embed in an iframe — clickjacking. Set to `'self'` or specific origins.

### Mistake 6 — `report-uri` without monitoring

A report endpoint nobody reads catches nothing useful. Pipe to your alerting (Datadog, Sentry, custom). Filter out extension noise (a lot of violation reports come from ad-blockers / password managers injecting scripts).

### Mistake 7 — Per-route policies

Maintaining per-route CSP is fragile. Apply one strict policy at the edge / middleware to every HTML response.

### Mistake 8 — `report-only` left in production "temporarily"

If you forgot to switch from report-only to enforcing, you have observation-mode CSP and no protection. Audit the actual response headers periodically.

## Trusted Types

DOM-based XSS happens when untrusted strings reach DOM sinks: `innerHTML`, `outerHTML`, `document.write`, `eval`, `setTimeout(string)`, `setInterval(string)`. The browser doesn't know which strings are dangerous.

Trusted Types changes this. Once enforced:

```
Content-Security-Policy:
  require-trusted-types-for 'script';
  trusted-types default sanitize-html;
```

Code that assigns a string to `innerHTML` now throws. To assign, you must produce a `TrustedHTML` from a registered policy:

```js
const policy = trustedTypes.createPolicy('default', {
  createHTML: (input) => DOMPurify.sanitize(input),
});

element.innerHTML = policy.createHTML(userInput);  // allowed
element.innerHTML = userInput;                      // throws TypeError
```

The policy name list in the CSP directive constrains which policies are allowed. `default` is a special name — when present, the browser automatically wraps DOM sink assignments in the `default` policy. Useful but powerful: if the `default` policy's `createHTML` is permissive, you're back where you started.

### Rollout

1. Add `trusted-types` directive *without* `require-trusted-types-for` — defines policies without enforcing.
2. Identify every DOM sink in the codebase, wrap in policy calls.
3. Add `require-trusted-types-for 'script'` in `Report-Only` first.
4. Monitor reports, fix remaining sinks.
5. Switch to enforcing.

### Library helpers

DOMPurify (https://github.com/cure53/DOMPurify) ships a `trustedTypes` hook for integration. Most modern frameworks have Trusted Types integration in their renderer (React 19+ has a `trustedTypes` policy option; Angular and Lit support it natively).

## Verifying a deployed CSP

Tools:
- **CSP Evaluator** (https://csp-evaluator.withgoogle.com) — paste the header, see weaknesses.
- **DevTools → Console** — CSP violations log in real time.
- **DevTools → Network** — view response headers; confirm enforcing vs report-only.
- **securityheaders.com** — overall headers grade.

Manual checks:
```bash
curl -sI https://app.example.com/ | grep -i content-security-policy
```

Visual check in DevTools:
- Open the deployed page.
- Console → check for `Refused to execute inline script` (good, CSP working).
- Application → Frames → top → Security → confirm CSP is enforcing.

## Audit checklist

1. CSP header present and enforcing (not just `Report-Only`).
2. `script-src` uses nonces or hashes; no `'unsafe-inline'`, no `'unsafe-eval'`.
3. `'strict-dynamic'` paired with nonces (or hashes) — no `https:`/`*` allowlist.
4. `object-src 'none'`, `base-uri 'none'|'self'`.
5. `frame-ancestors` restricting framing.
6. `report-uri` or `report-to` connected to monitoring.
7. Same policy applied to all HTML responses (edge / middleware).
8. `require-trusted-types-for 'script'` on apps with DOM sinks.
9. Trusted Types policies registered, all sinks routed through them.
10. No legacy `X-XSS-Protection` (deprecated; remove).
11. HSTS, `X-Content-Type-Options: nosniff` also set.
