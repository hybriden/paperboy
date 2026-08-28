---
name: nodejs-express-security
description: Security audit for Node.js HTTP servers using Express, Koa, Hapi, or plain http/https — covering middleware ordering, body parser config, helmet usage, session management with express-session, CORS configuration, error handling, file upload patterns (multer/busboy), and common Node-specific vulnerabilities like prototype pollution, ReDoS, and event loop blocking. Use this skill whenever the user mentions Express, Koa, Hapi, express-session, helmet, multer, body-parser, Node.js server, npm packages with known CVEs, or asks "audit my Express app", "Node.js security review", "is my Express middleware safe", "Koa security". Trigger when the codebase contains `require('express')`, `from 'express'`, `express()`, `new Koa()`, or similar Node HTTP server patterns.
---

# Node.js HTTP Server Security Audit

Audit Node.js backend code for vulnerabilities in HTTP servers built on Express, Koa, Hapi, or the standard library. Defensive find-and-fix.

## When this skill applies

- Reviewing Express / Koa / Hapi route handlers and middleware
- Auditing middleware order and configuration
- Reviewing file upload pipelines
- Checking error handling for info disclosure
- Identifying Node-specific risks (prototype pollution, event loop blocking, ReDoS, path traversal)
- Reviewing third-party Node packages for known issues

Use other skills for: NestJS (`nestjs-security`), Fastify (`fastify-security`), Hono (`hono-security`), Next.js API routes (`nextjs-security`), ORM-specific concerns (`prisma-orm-security`, `mongoose-mongodb-security`), generic patterns (`saas-security-pack/saas-code-security-review`).

## Workflow

Follow `../_shared/audit-workflow.md`. Node-specific notes below.

### Phase 1: Stack detection

```bash
# Identify framework
node -e "const p=require('./package.json'); console.log(Object.keys({...p.dependencies, ...p.devDependencies}).filter(k => /^(express|koa|hapi|fastify|nestjs|hono)$/.test(k)))"

# Node version
node --version
grep '"node":' package.json
```

### Phase 2: Inventory

```bash
# Entry point
grep -E '"main"|"start"' package.json

# Route definitions
grep -rn 'app\.\(get\|post\|put\|delete\|patch\|use\)\|router\.\(get\|post\)' src/ | head -50

# Middleware chain (often in app.js / server.js / index.js)
grep -rn 'app\.use(' src/

# Body parsers
grep -n 'body-parser\|express.json\|express.urlencoded\|koa-bodyparser' src/

# Session middleware
grep -rn 'express-session\|cookie-session\|koa-session' src/

# File uploads
grep -rn 'multer\|busboy\|formidable\|@fastify/multipart' src/

# CORS config
grep -rn 'cors(\|app.use(cors' src/

# Helmet (security headers)
grep -rn 'helmet' src/
```

### Phase 3: Detection — the checks

#### Middleware ordering

Order matters. Common bugs:

- **NDE-MW-1** `helmet()` registered AFTER body parsers and route handlers — security headers don't apply consistently. Register helmet first.
- **NDE-MW-2** Error handler not last — Express requires `(err, req, res, next)` middleware as the final use(). If a route handler throws before reaching it, errors hit the default handler which leaks stack traces.
- **NDE-MW-3** Auth middleware registered after routes that should be protected — those routes are unauthenticated.
  ```js
  // BAD
  app.use('/api/admin', adminRouter);
  app.use(requireAuth);  // ← too late, adminRouter already mounted unprotected
  
  // GOOD
  app.use(requireAuth);
  app.use('/api/admin', adminRouter);
  ```
- **NDE-MW-4** Rate limiter only on a subset of routes when it should apply broadly. Mount the limiter as early app.use, before routes.
- **NDE-MW-5** Body parser size limit too high (or default). Set explicitly:
  ```js
  app.use(express.json({ limit: '100kb' }));  // not '50mb' unless intended
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  ```
  `extended: false` uses querystring parser (safer), `extended: true` uses qs (prototype-pollution-vulnerable in old versions).

#### Helmet — what it sets

```js
import helmet from 'helmet';
app.use(helmet({
  contentSecurityPolicy: { /* see saas-frontend-hardening */ },
  crossOriginEmbedderPolicy: { policy: 'require-corp' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
  // ...
}));
```

- **NDE-HLM-1** Helmet installed and configured (not just imported).
- **NDE-HLM-2** Helmet's default CSP is strict — if the app sets a custom CSP, verify it's not weaker than helmet's default.
- **NDE-HLM-3** Helmet doesn't add headers if the response was already sent or piped (e.g., file streams). Confirm static file routes have headers too — `helmet.contentTypeOptions()` etc.

#### CORS

- **NDE-COR-1** `cors()` with no options uses `origin: '*'` — allows all origins, blocks credentials. Almost never what you want for an authenticated API.
- **NDE-COR-2** `origin: true` reflects whatever Origin is sent — equivalent to `*` for non-credentialed, but with `credentials: true` enabled, this is a serious vulnerability.
- **NDE-COR-3** Allowlist explicitly:
  ```js
  const allowList = ['https://app.yourorg.com', 'https://staging.yourorg.com'];
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || allowList.includes(origin)) cb(null, true);
      else cb(new Error('CORS blocked'));
    },
    credentials: true,
  }));
  ```
- **NDE-COR-4** Subdomain wildcard regex carefully: `/^https:\/\/.*\.yourorg\.com$/` matches `https://evil.yourorg.com.attacker.com` too if not anchored properly.

#### Session management (express-session, koa-session, cookie-session)

- **NDE-SES-1** Default session secret not used (`'keyboard cat'` or empty). Use a strong secret from env.
- **NDE-SES-2** `cookie: { secure: true, httpOnly: true, sameSite: 'lax', maxAge: ... }` set.
- **NDE-SES-3** Session store is not the default MemoryStore in production (MemoryStore leaks memory, doesn't share across instances).
- **NDE-SES-4** `resave: false, saveUninitialized: false` — don't write sessions for unauthenticated users.
- **NDE-SES-5** Session regeneration on login (`req.session.regenerate(...)` for express-session) — prevents session fixation.
- **NDE-SES-6** Session destruction on logout (`req.session.destroy(...)` AND clear cookie).
- **NDE-SES-7** Use `cookie-session` only for stateless tokens, not stateful sessions — it stores the full session in the cookie (size limit + tamper risk).

#### File uploads (multer, busboy, formidable)

- **NDE-UPL-1** `multer({ limits: { fileSize: ... } })` set to a reasonable max (avoids DoS via huge files).
- **NDE-UPL-2** `multer({ limits: { files: ..., fields: ... } })` — caps on file count and field count.
- **NDE-UPL-3** File type validated by magic bytes (file-type library), not just by `mimetype` or extension (both attacker-controlled).
- **NDE-UPL-4** `dest` or storage not in a web-accessible path. If files must be served, serve through a route that does authz, not via static directory.
- **NDE-UPL-5** Filenames sanitized — `path.basename` + strip dangerous chars + prefix with UUID. No raw `file.originalname` as filesystem path.
- **NDE-UPL-6** Disk storage temp files cleaned up on error.
- **NDE-UPL-7** Memory storage limits accounted for — `multer.memoryStorage()` loads entire file into memory.

```js
import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 3 },
});

app.post('/upload', upload.array('files', 3), async (req, res) => {
  for (const f of req.files) {
    const detected = await fileTypeFromBuffer(f.buffer);
    if (!detected || !['image/png', 'image/jpeg', 'image/webp'].includes(detected.mime)) {
      return res.status(400).json({ error: 'Unsupported type' });
    }
  }
  // ... save with UUID filename, never `f.originalname` as path
});
```

#### Path traversal

- **NDE-PATH-1** `res.sendFile(path.join(__dirname, req.params.file))` — `req.params.file` could be `../../../etc/passwd`. Use `path.resolve` + check the result is under the intended root:
  ```js
  const root = path.resolve('./public');
  const file = path.resolve(root, req.params.file);
  if (!file.startsWith(root + path.sep)) return res.status(400).end();
  res.sendFile(file);
  ```
- **NDE-PATH-2** `express.static` correctly restricts to its root; custom file-serving routes often don't.
- **NDE-PATH-3** Archive extraction (zip, tar) — extract paths verified to stay within target dir (zip-slip vulnerability).

#### Prototype pollution

- **NDE-PP-1** `qs` (used by `express.urlencoded({ extended: true })`) in old versions had prototype pollution issues. Ensure express + qs are current.
- **NDE-PP-2** `lodash.merge`, `lodash.mergeWith`, `_.defaultsDeep` with user input → prototype pollution. Use `_.merge` from current lodash; better, avoid these functions on untrusted input entirely.
- **NDE-PP-3** Custom merge / extend functions verified to skip `__proto__`, `constructor`, `prototype` keys.

#### ReDoS (Regular expression DoS)

- **NDE-REDOS-1** User input matched against complex regex with backtracking is a DoS vector. Audit any `String.match` / `RegExp.test` against user input where the pattern has nested quantifiers.
- **NDE-REDOS-2** Use safe regex libraries (`safe-regex`, `re2` for re-implementing in Rust) or precompile and limit.

#### Event loop blocking

- **NDE-LOOP-1** No synchronous file I/O (`readFileSync`) in request handlers. Use async.
- **NDE-LOOP-2** No synchronous crypto (`crypto.pbkdf2Sync` on long-running passwords). Use async variant.
- **NDE-LOOP-3** JSON.parse / stringify of large payloads — set body size limits.
- **NDE-LOOP-4** CPU-heavy work (image processing, PDF generation) offloaded to worker threads or external services.

#### Error handling and info disclosure

- **NDE-ERR-1** Catch-all error handler in production returns generic messages; stack traces logged server-side only.
  ```js
  app.use((err, req, res, next) => {
    logger.error({ err, req: { method: req.method, url: req.url, id: req.id } });
    res.status(err.status || 500).json({ error: 'Internal Server Error' });
  });
  ```
- **NDE-ERR-2** No `app.disable('etag')` needed, but `app.disable('x-powered-by')` set (or rely on helmet to strip it).
- **NDE-ERR-3** 404 handler returns minimal info; doesn't echo back the requested path verbatim if not needed.

#### Dependency hygiene

- **NDE-DEP-1** `npm audit` clean for `--production` deps OR exceptions documented.
- **NDE-DEP-2** Dependency-graph awareness — many Express middleware packages haven't been updated in years. Replace unmaintained ones.
- **NDE-DEP-3** Specific high-impact CVEs to check:
  - Old `body-parser`, `qs`, `lodash`, `minimist`, `node-fetch` versions
  - `axios < 1.7` (various CVEs)
  - `passport-*` strategies with known weaknesses

#### Native modules and child_process

- **NDE-CP-1** `child_process.exec` with user-controlled args — use `execFile` (no shell) with arg array.
- **NDE-CP-2** Native modules from non-official sources audited; supply chain risk.
- **NDE-CP-3** `vm.runInNewContext` with user code is NOT a sandbox (Node leaks easily) — use `isolated-vm` if truly needed, or refactor.

### Phase 4: Triage

Critical class examples:
- `cors({ origin: true, credentials: true })` with auth cookies
- `multer` accepting any file type, saved with `originalname` as path
- Session middleware with default secret
- Express version with CVEs in dependency chain
- `child_process.exec` with user input

### Phase 5: Report

Use `../_shared/findings-schema.md`. Prefix IDs with `NDE-`.

## References

- `references/middleware-order-pitfalls.md` — Common middleware misordering, with diagnostic patterns
