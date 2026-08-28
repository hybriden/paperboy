# Cross-Origin Isolation: COOP, COEP, CORP

Authoritative sources:
- web.dev — [Why you need cross-origin isolated for powerful features](https://web.dev/articles/why-coop-coep)
- web.dev — [Making your website cross-origin isolated](https://web.dev/articles/coop-coep)
- web.dev — [COEP credentialless](https://developer.chrome.com/blog/coep-credentialless-origin-trial)
- HTML spec — [`Cross-Origin-Opener-Policy`](https://html.spec.whatwg.org/multipage/browsing-the-web.html#cross-origin-opener-policies)
- HTML spec — [`Cross-Origin-Embedder-Policy`](https://html.spec.whatwg.org/multipage/origin.html#coep)
- Fetch — [`Cross-Origin-Resource-Policy`](https://fetch.spec.whatwg.org/#cross-origin-resource-policy-header)

## Why these headers exist

Spectre-class attacks let a page on origin A measure timing differences to read memory from origin B if both share a process. Modern browsers respond by isolating origins into different processes — but only when the page opts in via COOP + COEP. The pair is the price of admission for several "powerful" web features:

- `SharedArrayBuffer`
- High-resolution `performance.now()` (sub-millisecond)
- `performance.measureUserAgentSpecificMemory()`
- (Some) WebAssembly threads
- (Some) WebGPU features

If `window.crossOriginIsolated === true`, you have the isolation. Otherwise, those APIs return restricted values or throw.

The third header in the trio — CORP — is set on RESOURCES (images, scripts, API responses) and declares who is allowed to embed them.

## The three headers

| Header | Set on | Says |
|--------|--------|------|
| `Cross-Origin-Opener-Policy` (COOP) | top-level pages | "Severs my window's relationship with the opener if the opener is cross-origin" |
| `Cross-Origin-Embedder-Policy` (COEP) | top-level pages | "Only embed subresources that opt into being embedded" |
| `Cross-Origin-Resource-Policy` (CORP) | resources | "Who may embed me" |

## COOP — opener isolation

```
Cross-Origin-Opener-Policy: same-origin
```

When the page is loaded:
- If it has an opener (`window.opener !== null`), and the opener is cross-origin, the opener relationship is severed — `opener` becomes `null`, the previous page becomes a "noopener" tab.
- Same for popups this page opens to cross-origin destinations.

Values:
- `same-origin` — strict. Sever cross-origin opener/popup relationships.
- `same-origin-allow-popups` — strict for opener; popups to cross-origin sites keep the relationship (useful if you OAuth-popup an IDP).
- `unsafe-none` — default, no isolation.

Set `same-origin` unless you have a documented need for popup interop.

### Reporting (rollout aid)

```
Cross-Origin-Opener-Policy: same-origin; report-to="coop-violations"
Reporting-Endpoints: coop-violations="https://example.report-uri.com/r/d/coop/enforce"
```

Or report-only mode during rollout:

```
Cross-Origin-Opener-Policy-Report-Only: same-origin; report-to="coop-violations"
```

## COEP — embedder policy

```
Cross-Origin-Embedder-Policy: require-corp
```

Every subresource (image, font, script, style, frame, fetch) the page loads from a different origin must opt in via `Cross-Origin-Resource-Policy: same-origin` or `cross-origin`. Resources without CORP fail to load.

Values:
- `require-corp` — strict. Every cross-origin subresource needs `CORP` or `CORS` headers.
- `credentialless` — looser. Cross-origin subresources may load without `CORP`, but they're fetched WITHOUT credentials (no cookies, no client cert). Useful when you embed third-party content (analytics, ad iframes) you don't control.
- `unsafe-none` — default, no isolation.

### Migrating to COEP

The hard part is identifying every cross-origin subresource and either:
1. Setting `CORP` on it (if you control the resource server), or
2. Switching to `crossorigin` attribute + CORS on the resource (if it serves CORS), or
3. Choosing `credentialless` if you can tolerate unauthenticated fetches, or
4. Removing the dependency.

Use report-only mode first:

```
Cross-Origin-Embedder-Policy-Report-Only: require-corp; report-to="coep-violations"
```

Each violation tells you which subresource lacked CORP/CORS.

## CORP — resource policy

```
Cross-Origin-Resource-Policy: same-origin
```

Set on the RESOURCE response. The receiving browser (when fetching from a different origin) only loads the resource if its CORP value permits.

Values:
- `same-origin` — only the resource's origin may load it (typical for private API responses).
- `same-site` — only the resource's eTLD+1 may load it (typical for shared assets across subdomains).
- `cross-origin` — anyone may load it (typical for public CDN assets, fonts).

Audit checklist for CORP:
- API responses with user data → `same-origin` (or `same-site` if your app spans subdomains)
- Public assets (icons, fonts on a CDN) → `cross-origin` is fine
- Static HTML pages → CORP unnecessary (top-level navigation isn't a "load" in this sense)

## Achieving cross-origin isolation

A page is `crossOriginIsolated` when ALL of:
- It has `Cross-Origin-Opener-Policy: same-origin`
- It has `Cross-Origin-Embedder-Policy: require-corp` or `credentialless`
- Every subresource it loads passes the COEP check

Verify:
```js
console.log(self.crossOriginIsolated);  // → true if isolated
console.log(typeof SharedArrayBuffer !== 'undefined');  // → true if isolation gates passed
```

## Common rollout pitfalls

### Pitfall 1 — Embedded third-party widgets break

A page that embeds `<iframe src="https://analytics.example/widget.js">` and the widget doesn't set CORP. After enabling COEP, the iframe fails to load.

Options:
- Ask the third party to add `CORP: cross-origin` on their endpoint.
- Switch to `credentialless` if you can tolerate uncredentialed fetches.
- Remove the embed.

### Pitfall 2 — `SharedArrayBuffer` works in dev, breaks in prod

Dev server uses `unsafe-none` (default), prod uses `require-corp`. A `crossOriginIsolated` check that returns `true` locally but `false` in prod means the prod environment has a subresource failing the COEP check. Open DevTools → Network → look for blocked subresources.

### Pitfall 3 — Forgotten COOP

Adding only `Cross-Origin-Embedder-Policy: require-corp` doesn't give you `crossOriginIsolated`. Both are required.

### Pitfall 4 — Auth popup breaks

`Cross-Origin-Opener-Policy: same-origin` severs popups to your OAuth IDP. The IDP can't `window.opener.postMessage(...)` back. Use `same-origin-allow-popups` for pages that need cross-origin popup IPC, or switch to redirect-based OAuth instead of popup-based.

### Pitfall 5 — `credentialless` security gotchas

`credentialless` strips cookies/credentials on cross-origin fetches that lack CORP. If the cross-origin endpoint serves different content based on the user's session (e.g., an avatar URL that varies by who's logged in), it'll now serve the unauthenticated version. Usually fine for static assets; check before flipping the switch.

## Verifying the headers

```bash
curl -sI https://app.example.com/ | grep -iE 'cross-origin'
```

Expected on a fully-isolated app:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

For API endpoints:
```bash
curl -sI https://api.example.com/v1/users | grep -i 'cross-origin-resource-policy'
```

Expected:
```
Cross-Origin-Resource-Policy: same-origin
```

DevTools:
- Application → Frames → top → Security context — shows isolation state, COOP/COEP active values, any violations.
- Console — `crossOriginIsolated` and `typeof SharedArrayBuffer`.

## Audit checklist

For top-level pages:
1. `Cross-Origin-Opener-Policy: same-origin` (or `same-origin-allow-popups` with documented rationale).
2. `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless` with documented rationale).
3. Report endpoints configured during rollout.

For API / resource responses:
4. `Cross-Origin-Resource-Policy: same-origin` on private resources.
5. `Cross-Origin-Resource-Policy: cross-origin` only on public assets.

For embedded contexts:
6. Third-party embeds either ship CORP or have been migrated to `credentialless` / removed.
7. `crossOriginIsolated === true` on pages that need `SharedArrayBuffer` / high-resolution timers / wasm threads.
