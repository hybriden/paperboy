# Vite Env Vars and Config Reference

Load this when reviewing how a Vite project handles env vars, build-time injection, and dev-vs-prod boundaries.

## The two-axis env model

Vite splits env vars on two axes:

| Axis | Values |
|------|--------|
| **Prefix** | `VITE_*` (exposed to client bundle) vs other (build/server only) |
| **File** | `.env` (always loaded) vs `.env.<mode>` vs `.env.local` (gitignored) |

A variable like `VITE_API_URL` in `.env.production` is loaded during production builds and inlined into the client JS. A variable like `DATABASE_URL` in the same file is read by Vite's config at build time but doesn't reach the client.

## What lands in the bundle

```ts
// src/api.ts
console.log(import.meta.env.VITE_API_URL);    // ✓ replaced at build with the value
console.log(import.meta.env.DATABASE_URL);    // undefined in client — never injected
```

Vite literally text-replaces `import.meta.env.VITE_FOO` with the string value. After build, the bundle contains the literal value — searchable with grep.

## Audit techniques

### 1. List declared variables

```bash
# All .env files in the repo
cat .env .env.* 2>/dev/null | grep -E '^[A-Z_]+=' | sort -u

# Specifically the VITE_-prefixed ones (these ship to client)
cat .env .env.* 2>/dev/null | grep -E '^VITE_' | sort -u
```

For each VITE_ var, ask "is this truly public?" If the value would harm anything if printed in an attacker's terminal, it's not VITE_.

### 2. Inspect the built bundle

```bash
npm run build
# Search for suspicious-looking values
grep -rhoE '(sk|pk)_(live|test)_[A-Za-z0-9_]+|AKIA[0-9A-Z]{16}|xox[bp]-[a-zA-Z0-9-]+|ghp_[A-Za-z0-9]+|VITE_[A-Z_]+' dist/ | sort -u
```

If any provider-format secrets show up, you have a confirmed leak. If only `VITE_PUBLIC_*` strings show up (no secret-looking values), the build is clean.

### 3. Check for `define:` config

```bash
grep -A3 'define:' vite.config.*
```

The `define` option is identical to `VITE_` prefix in security model — it text-replaces in the bundle. Don't use it for secrets.

```ts
// BAD — replaces __SECRET__ in code with the actual secret value, shipping to bundle
export default defineConfig({
  define: {
    __SECRET__: JSON.stringify(process.env.STRIPE_SECRET_KEY),
  },
});
```

### 4. Check for `envPrefix` override

Some teams change the prefix from `VITE_` to something custom (e.g., `APP_PUBLIC_`):

```ts
export default defineConfig({
  envPrefix: 'APP_PUBLIC_',
});
```

This doesn't change the security model — variables with the configured prefix still ship to the bundle. Audit those.

### 5. Confirm `.env*` files are gitignored

```bash
git check-ignore .env .env.local .env.production .env.development 2>&1
```

Should show each file as ignored. `.env.example` (with placeholder values) should be committed; everything else with real values should not.

## Mode awareness

Vite uses `--mode` to select which `.env.<mode>` file to load:

```bash
vite build --mode staging   # loads .env.staging
vite build                  # loads .env.production (default for build)
vite                        # loads .env.development (default for dev)
```

- **VIT-MODE-1** Sensitive vars are NOT in `.env` (always loaded) when they should only apply to one mode.
- **VIT-MODE-2** Production secrets not duplicated in `.env.development` for convenience — staging secrets in dev, dev secrets in staging.
- **VIT-MODE-3** CI builds explicitly set `--mode production` or rely on the default.

## Build-time vs runtime

Vite is build-time: env vars are resolved when `vite build` runs. Runtime config changes require a rebuild.

If you need runtime config (e.g., per-deployment API URLs without rebuild):

- Serve a `/config.json` from the host that the app fetches at startup.
- Or use placeholders + runtime replacement at the edge (Cloudflare Worker, nginx sub_filter).

Don't use `VITE_` for things that change per-deployment without rebuild — they become baked.

## `import.meta.env` reference

| Variable | Type | Source |
|----------|------|--------|
| `import.meta.env.MODE` | string | The mode (production / development / custom) |
| `import.meta.env.BASE_URL` | string | The base public path |
| `import.meta.env.PROD` | boolean | True in production builds |
| `import.meta.env.DEV` | boolean | True in dev / `vite serve` |
| `import.meta.env.SSR` | boolean | True during SSR build / server bundle |
| `import.meta.env.VITE_*` | string | User-defined, prefixed |

`import.meta.env.PROD` / `DEV` flags can gate dev-only code, but the dead-code elimination only fully removes `if (import.meta.env.DEV) { ... }` blocks when the value is statically known. Use `if (__DEV__)` patterns from `define` for guaranteed removal.

## Common findings

| Finding | Severity | Fix |
|---------|----------|-----|
| `VITE_STRIPE_SECRET_KEY` in .env | Critical | Remove `VITE_` prefix; access only from server / build script |
| `VITE_SUPABASE_SERVICE_ROLE_KEY` | Critical | Same — service_role is server-only |
| Dev-only debug code shipped (no DCE) | Low-Med | Extract to dev-only files; use `__DEV__` define |
| `.env.local` committed | High | Remove from history, rotate exposed values |
| `envPrefix: ''` (no prefix; all env exposed) | Critical | Set to `VITE_` |
| Source maps with embedded `.env` values | High | Disable in production or upload to private store |

## Verifying after fixes

```bash
# After applying fixes
rm -rf dist node_modules/.vite
npm run build
grep -rhoE '(sk|pk)_(live|test)_[A-Za-z0-9_]+|AKIA[0-9A-Z]{16}' dist/ || echo "clean"
```

A fresh build with cache cleared confirms the changes propagated.
