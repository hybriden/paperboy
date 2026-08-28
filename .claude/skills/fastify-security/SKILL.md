---
name: fastify-security
description: Security audit for Fastify applications including schema validation, hooks (onRequest, preHandler, preValidation), plugin scoping, encapsulation, fastify-helmet/fastify-cors/fastify-rate-limit setup, JSON schema strictness, and Fastify-specific patterns. Use this skill whenever the user mentions Fastify, @fastify/*, fastify-plugin, FastifyInstance, route schemas, fastify hooks, or asks "audit my Fastify app", "Fastify security", "schema validation". Trigger when the codebase contains `fastify` or `@fastify/*` in package.json.
---

# Fastify Security Audit

Audit Fastify HTTP servers. Fastify's schema-first design provides strong defaults if used correctly.

## When this skill applies

- Reviewing Fastify route definitions and schemas
- Auditing plugin chain and encapsulation
- Reviewing hooks (onRequest, preHandler, preValidation, onResponse)
- Checking security plugin configuration

## Workflow

Follow `../_shared/audit-workflow.md`. Companion: `nodejs-express-security` for cross-cutting Node concerns.

### Phase 1: Stack detection

```bash
grep -E '"fastify":|"@fastify/' package.json
```

### Phase 2: Inventory

```bash
# Route definitions
grep -rn 'fastify\.\(get\|post\|put\|delete\|patch\|register\)' src/ | head -50

# Schemas
grep -rnE 'schema:\s*{' src/ | head -20

# Hooks
grep -rn '\.addHook\(\|preHandler:\|preValidation:\|onRequest:' src/

# Security plugins
grep -nE '@fastify/(helmet|cors|rate-limit|jwt|cookie|session|multipart|csrf-protection)' package.json
```

### Phase 3: Detection — the checks

#### Schema validation

Fastify validates inputs against JSON Schema on every request — if you provide one.

- **FST-SCH-1** Every route has a schema for `body`, `params`, `querystring`. Missing schema = no validation.
- **FST-SCH-2** Schema uses strict types and ranges:
  ```ts
  fastify.post('/users', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        additionalProperties: false,    // ← strips/rejects extras
        properties: {
          email: { type: 'string', format: 'email', maxLength: 254 },
          password: { type: 'string', minLength: 8, maxLength: 128 },
        },
      },
    },
  }, async (req, reply) => { ... });
  ```
- **FST-SCH-3** `additionalProperties: false` set globally OR on every schema. Without it, mass assignment is possible.
- **FST-SCH-4** Response schemas defined — they filter the response to only declared fields (built-in defense against accidental data exposure):
  ```ts
  schema: {
    response: {
      200: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          displayName: { type: 'string' },
          // passwordHash explicitly absent
        },
      },
    },
  }
  ```
- **FST-SCH-5** AJV configured strictly (default in current Fastify); custom keywords reviewed for soundness.

#### Hooks

Fastify has multiple hook points; auth typically in `onRequest` or `preHandler`.

- **FST-HK-1** Auth hook applied to protected routes via plugin scope or global hook with opt-out for public routes.
- **FST-HK-2** Hooks run in registration order; auth before validation is fine, but verify the order matches intent.
- **FST-HK-3** Hooks throwing errors propagate to error handler — don't swallow.

#### Plugin encapsulation

Fastify plugins create scopes. Auth applied in one plugin doesn't apply to sibling plugins unless registered up-stack:

```ts
// BAD — auth only applies to /api/v1 subtree
fastify.register(async (app) => {
  app.addHook('preHandler', authHook);
  app.register(userRoutes, { prefix: '/api/v1' });
});
// /api/v2 routes registered elsewhere have NO auth

// GOOD — auth at top level
fastify.addHook('preHandler', authHook);
fastify.register(userRoutes, { prefix: '/api/v1' });
fastify.register(adminRoutes, { prefix: '/api/v2' });
```

- **FST-PLG-1** Auth/security hooks at the top level OR encapsulated explicitly per plugin scope.
- **FST-PLG-2** `fastify-plugin` wrapper used when a plugin's effects (including hooks) should escape its scope. Conversely, plugins that should be scoped should NOT use `fastify-plugin`.

#### Security plugins

- **FST-SP-1** `@fastify/helmet` registered. Same options as Express helmet.
- **FST-SP-2** `@fastify/cors` with specific origin allowlist.
- **FST-SP-3** `@fastify/rate-limit` registered globally (or per-route for fine-tuning).
- **FST-SP-4** `@fastify/csrf-protection` if using cookie-based session.
- **FST-SP-5** `@fastify/multipart` with size limits if file uploads.
- **FST-SP-6** `@fastify/cookie` and `@fastify/session` configured securely (httpOnly, secure, sameSite — see `saas-security-pack/saas-frontend-hardening/references/cookie-config.md`).

#### Body parser limits

- **FST-BP-1** `bodyLimit` set on FastifyInstance (default 1MB; lower if appropriate, never higher without specific reason).
- **FST-BP-2** Per-route override for upload routes only.

#### JWT (`@fastify/jwt`)

- **FST-JWT-1** Secret/key from env, not committed.
- **FST-JWT-2** Algorithm specified (don't accept `none`).
- **FST-JWT-3** See `saas-security-pack/saas-code-security-review/references/jwt-validation.md`.

#### Error handling

- **FST-ERR-1** `setErrorHandler` configured to scrub internal details in production.
- **FST-ERR-2** Validation errors return generic messages (don't echo full schema paths that reveal internal field names).

#### Logging

- **FST-LOG-1** Fastify's pino logger configured to redact sensitive paths:
  ```ts
  const fastify = Fastify({
    logger: {
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password'],
    },
  });
  ```
- **FST-LOG-2** No password / token in request bodies logged at info level.

#### Microservice / WS

If using `@fastify/websocket`:
- **FST-WS-1** WebSocket connection auth via the initial HTTP upgrade — same auth as REST routes.
- **FST-WS-2** Origin validation on upgrade.

#### Dependencies

- **FST-DEP-1** Fastify v4 or v5 (current). Older versions deprecated.
- **FST-DEP-2** `@fastify/*` packages match Fastify major version.

### Phase 4: Triage

Critical: route without schema accepting body; encapsulation bug where auth hook missing from a route group; default `bodyLimit` with file upload routes.

### Phase 5: Report

Use `../_shared/findings-schema.md`. Prefix IDs with `FST-`.
