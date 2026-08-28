---
name: vite-security
description: Security audit specific to Vite-based applications including vite.config.ts/js, dev server exposure, environment variable handling (VITE_ prefix), plugin chain audit, build output inspection, dependency pre-bundling, and Vite-specific deployment patterns. Use this skill whenever the user mentions Vite, vite.config, VITE_ environment variables, Vitest, Rollup-via-Vite, plugins like vite-plugin-*, or asks "audit my Vite app", "Vite env vars", "Vite dev server safe", "Vite build security". Trigger when the codebase contains a `vite.config.ts/js/mjs` file or `vite` in `package.json` devDependencies.
---

# Vite Security Audit

Audit a Vite-based project for security issues specific to Vite's dev server, build pipeline, environment-variable model, and plugin ecosystem. Covers Vite 3 / 4 / 5 / 6.

## When this skill applies

- Reviewing `vite.config.ts/js/mjs` for misconfigurations
- Auditing the env var setup (`VITE_` prefix model)
- Checking Vite plugins for known issues
- Reviewing build output for accidentally-shipped secrets or dev-only code
- Auditing Vite dev server exposure (local network, tunnel, demo deployments)
- Confirming production build settings match security expectations

Use other skills for: React/Vue/Svelte component-level issues (`react-security`, `vue-nuxt-security`, `svelte-sveltekit-security`), backend code, deployment platform (`vercel-platform-security`, `cloudflare-workers-security`).

## Workflow

Follow `../_shared/audit-workflow.md`. Vite-specific notes below.

### Phase 1: Stack detection

```bash
# Detect Vite version
grep -E '"vite":' package.json

# Detect framework template (React/Vue/Svelte/Solid/Qwik)
grep -E '@vitejs/plugin-(react|vue|svelte)|vite-plugin-solid|vite-plugin-qwik' package.json

# Find config
ls vite.config.* vitest.config.* 2>/dev/null
```

### Phase 2: Inventory

```bash
# Plugin chain
grep -E 'plugins:|VitePlugin' vite.config.* 

# Env var usage
grep -rn 'import\.meta\.env\.' src/ | head -30

# Define / replace patterns (often used to inject values at build time)
grep -nE 'define:\s*{|process\.env' vite.config.*

# Dev server config (host, port, proxy, allowedHosts)
grep -nE 'server:|preview:' vite.config.*

# Build target & output
grep -nE 'build:|outDir' vite.config.*
```

### Phase 3: Detection — the checks

#### Environment variables — the `VITE_` prefix

Same trap as Next.js's `NEXT_PUBLIC_`: variables prefixed with `VITE_` are exposed to client code at build time. Anything without the prefix is server/build-side only and won't leak.

- **VIT-ENV-1** Every `VITE_` variable verified as truly public (analytics IDs, public API URLs, feature flags — yes; API keys, secrets, DB URLs — never).
- **VIT-ENV-2** No `VITE_*_SECRET`, `VITE_*_KEY`, `VITE_*_PASSWORD`. Audit `.env`, `.env.local`, `.env.production`, and `.env.example`.
- **VIT-ENV-3** Production build inspected for env values:
  ```bash
  npm run build
  grep -rhoE 'VITE_[A-Z_]+|sk_[a-z]+_[A-Za-z0-9]+|AKIA[0-9A-Z]{16}' dist/ | sort -u
  ```
  Any values that look secret-shaped in the build are findings.
- **VIT-ENV-4** Custom prefix configured via `envPrefix` — confirm it's the same trap (exposes to bundle). Renaming the prefix doesn't change the security model.
- **VIT-ENV-5** `define` option in `vite.config.ts` — same risk as VITE_ prefix; the values are inlined into the build. Don't `define: { __SECRET__: process.env.SECRET }`.

#### `import.meta.env` model

```ts
// import.meta.env.MODE             — 'development' | 'production' | custom
// import.meta.env.PROD             — true in production
// import.meta.env.DEV              — true in development
// import.meta.env.VITE_FOO         — user-set, ships to bundle
// import.meta.env.SOMETHING        — without VITE_ prefix, undefined in client code
```

- **VIT-ENV-6** Code paths gated only by `import.meta.env.DEV` ship to production (the check evaluates `false`, but the surrounding code is still bundled unless dead-code elimination removes it). Sensitive dev-only utilities should be in separate files imported only by dev-time entry points.

#### Dev server exposure

The Vite dev server is for local development. When it's exposed beyond `127.0.0.1`, security issues:

- **VIT-DEV-1** `server.host: true` or `server.host: '0.0.0.0'` exposes dev server on the LAN. Verify intent (mobile testing? team demo?) and that the network is trusted. Don't expose dev server to public internet via tunnels (ngrok, Cloudflare Tunnel) without understanding the risk.
- **VIT-DEV-2** Vite dev server's HMR WebSocket may not have origin validation in older versions — CVE-2023-49293, CVE-2024-23331 (similar class). Update to a current Vite version.
- **VIT-DEV-3** `server.proxy` configs that proxy `/api` to a backend may expose internal endpoints to anyone reaching the dev server. Don't expose dev servers with proxy enabled.
- **VIT-DEV-4** `server.fs.allow` / `server.fs.deny` — Vite serves files from disk in dev. The defaults restrict to the project root, but custom configs can broaden the surface. Anything outside the project root → potential file disclosure.
  
  CVE-2025-30208 class: file-read bypass via specific URL patterns. Confirm Vite version is patched.
  
  CVE-2024-31207, CVE-2025-31125, CVE-2025-31486, CVE-2025-32395, CVE-2025-46565, CVE-2025-58751, CVE-2025-58752, CVE-2025-64756 — multiple `server.fs` and `allowedHosts` bypasses across 2024–2025. The fix in all cases is updating Vite to a current patch release.
- **VIT-DEV-5** `server.allowedHosts` — used to restrict which Host headers the dev server accepts. Set to specific hostnames; do not use `true` (allow any) in dev servers reachable beyond localhost.
- **VIT-DEV-6** `preview` server (used for `vite preview`) is for testing production builds locally. Same exposure considerations as `server`.

#### Build configuration

- **VIT-BLD-1** `build.sourcemap: true` in production ships source maps to the CDN. Source maps reveal original code (TypeScript, comments, internal structure). Two acceptable patterns:
  - Don't ship source maps to production (set `false`).
  - Ship source maps but upload to a separate location (Sentry) and serve them only to error-tracking, not to public.
- **VIT-BLD-2** `build.minify: false` in production — leaks variable names, comments. Set to `'esbuild'` (default) or `'terser'`.
- **VIT-BLD-3** `build.target: 'esnext'` may emit code only modern browsers can parse — fine, but verify the deployment surface (older browsers fall off).
- **VIT-BLD-4** `build.rollupOptions.output.manualChunks` configurations — if chunking exposes module names that hint at internal architecture (e.g., `admin-internal.js`), consider opaque chunk names.

#### Plugins — supply chain

- **VIT-PLG-1** Every plugin in `plugins:` array is from a known publisher. Vite plugin ecosystem has been targeted by typosquatting and malicious publishes.
- **VIT-PLG-2** Plugins pinned to specific versions in `package.json` with a lockfile.
- **VIT-PLG-3** Plugins with broad permissions (file write, network access at build time) reviewed individually. Build-time plugins run with the same privileges as the build user — they can exfiltrate env vars during the build.
- **VIT-PLG-4** No plugins from main/master/git URLs (use published npm versions for auditability).

Common plugins worth knowing:
- `vite-plugin-pwa` — service worker generation; if misconfigured, can cache too aggressively or fail to invalidate.
- `vite-plugin-mock` — adds API mocking; ensure not enabled in production.
- `unplugin-icons` — pulls icon packs; verify the icons are from expected sources.
- `vite-plugin-checker` — type-check during build; dev-only.

#### Production deployment

- **VIT-DEP-1** Built static assets served with appropriate cache headers; immutable file hashes in filenames enable long-term caching.
- **VIT-DEP-2** Production build excludes development dependencies (`vite`, `@vitejs/*`, test runners) — verify by inspecting `node_modules` size or `package.json` for misplaced runtime deps.
- **VIT-DEP-3** SPA fallback configured at the host so deep links work; but the fallback doesn't expose `vite.config.*` or `.env*` files (always confirm `.env*` is in `.gitignore`).
- **VIT-DEP-4** Production hosting (Cloudflare Pages, Vercel, Netlify, S3+CloudFront) configured with appropriate security headers — Vite doesn't apply headers; the host does. See `saas-security-pack/saas-frontend-hardening`.

#### Mock plugins / dev tooling shipped

- **VIT-DEV-7** No `vite-plugin-mock`, `msw` setup, or in-app debug routes shipped to production build. Audit `dist/` for occurrences:
  ```bash
  grep -rE 'mock|msw|__DEBUG__' dist/
  ```

#### Testing — Vitest

- **VIT-TST-1** `vitest.config.ts` doesn't accidentally expose globals that production code consumes (e.g., `globals.crypto` mocks shouldn't bleed into prod code).
- **VIT-TST-2** Test files in `node_modules` exclusions; test-only fixtures aren't in the source bundle.

### Phase 4: Triage

Critical class examples:
- `VITE_*_SECRET` confirmed in production bundle
- Dev server exposed to public internet
- Vite version with known file-read CVE in use
- Source maps with embedded secrets shipped to CDN
- Build-time plugin exfiltrating env to remote endpoint

### Phase 5: Report

Use `../_shared/findings-schema.md`. Prefix IDs with `VIT-`.

## References

- `references/env-vite-config.md` — Detailed env var model, define vs envPrefix, audit techniques
