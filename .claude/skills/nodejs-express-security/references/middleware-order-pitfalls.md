# Middleware Order Pitfalls Reference

Load this when auditing Express / Koa / Hapi middleware chains.

## The general principle

Middleware runs in registration order. The first `app.use(...)` runs first; the last runs last (and error handlers come after that). Bugs happen when developers mentally model the order wrong or copy snippets without understanding placement.

## The canonical Express order

```js
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import morgan from 'morgan';
import session from 'express-session';
import csrf from 'csurf';   // or use double-submit with SameSite cookies
import authMiddleware from './middleware/auth';
import routes from './routes';

const app = express();

// 1. Trust proxy if behind one (must be first for downstream to see real IP)
app.set('trust proxy', 1);

// 2. Security headers — first so they're set on every response, including errors
app.use(helmet());

// 3. CORS — early, before any route handling
app.use(cors({ origin: allowList, credentials: true }));

// 4. Rate limiting — before expensive parsing
app.use(rateLimit({ windowMs: 60_000, max: 100 }));

// 5. Compression (response) and logging
app.use(compression());
app.use(morgan('combined'));

// 6. Body parsers with explicit limits
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// 7. Cookie parser if needed by session
import cookieParser from 'cookie-parser';
app.use(cookieParser());

// 8. Session (after cookie parser, after body parser if storing in cookie)
app.use(session({ /* ... */ }));

// 9. CSRF (after session) — only for cookie-based session, not Bearer token APIs
app.use(csrf({ cookie: false }));   // uses session for token

// 10. Authentication
app.use(authMiddleware);

// 11. Routes
app.use('/api', routes);

// 12. 404 handler (only matches if no route did)
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

// 13. Error handler — must be last, must have 4 args
app.use((err, req, res, next) => {
  logger.error({ err, req: req.id });
  res.status(err.status || 500).json({ error: 'Internal Server Error' });
});
```

## Bugs caused by wrong order

### Bug 1 — helmet after routes

```js
app.use('/api', routes);  // these responses don't get helmet's headers
app.use(helmet());         // too late
```

The headers only apply to responses from middleware/routes registered AFTER helmet. Static file responses (`express.static`) before helmet also miss headers.

### Bug 2 — Auth middleware after public routes that should be protected

```js
app.use('/api/public', publicRouter);     // OK, intentionally public
app.use('/api/admin', adminRouter);       // BUG — registered before auth
app.use(authMiddleware);                  // applies only to whatever follows
app.use('/api/users', usersRouter);       // protected
```

`adminRouter` is unprotected because auth middleware was registered after it. Fix: register auth first, or mount it explicitly on protected routers.

### Bug 3 — Rate limiter after parsing/work

```js
app.use(express.json({ limit: '50mb' }));   // expensive parse first
app.use(rateLimit({ max: 100 }));           // limiter too late
```

Attackers can send 50MB JSON bodies before being rate-limited. CPU and memory exhausted before the limiter kicks in. Limiter must come before body parser, or at least before any expensive parsing.

### Bug 4 — CORS before security headers

```js
app.use(cors());          // adds Access-Control-Allow-Origin
app.use(helmet());        // sets various headers
```

This order is actually fine for most cases — helmet doesn't conflict with CORS. But if you customize helmet's `crossOriginResourcePolicy`, you can confuse CORS. Order them deliberately and document the rationale.

### Bug 5 — Error handler missing 4 args

```js
app.use((err, req, res) => { /* ... */ });  // ← missing `next` — Express won't treat this as error handler
```

Express identifies error handlers by their arity (4 parameters). With 3, this is a regular middleware and won't catch errors from `next(err)`.

### Bug 6 — Body parser limit too high (or not set)

```js
app.use(express.json());   // default limit is 100kb but VERIFY for old versions
```

Old `body-parser` defaults varied. Always set `limit` explicitly. Don't use `'50mb'` unless you have a specific upload route that needs it (and even then, that route should have its own parser with the larger limit, not the global one).

### Bug 7 — `extended: true` exposes prototype pollution

```js
app.use(express.urlencoded({ extended: true }));
```

`extended: true` uses `qs` library which has had prototype-pollution issues in older versions. With current versions it's safer, but `extended: false` (querystring parser) avoids the class entirely. Unless your API needs nested objects in form data (rare), use `extended: false`.

### Bug 8 — CSRF on Bearer-token APIs

```js
app.use(session({ ... }));
app.use(csrf({ cookie: false }));
// API only accepts Bearer tokens, not cookies
```

CSRF protection is meaningful when state-changing operations rely on ambient cookies. Pure Bearer-token APIs don't need CSRF tokens. Adding csurf here causes spurious failures.

### Bug 9 — Trust proxy not set behind a load balancer

```js
// Behind Cloudflare / AWS ALB / nginx
const app = express();
// no app.set('trust proxy', ...)
app.use(rateLimit({ keyGenerator: (req) => req.ip }));
```

`req.ip` returns the proxy's IP, not the client's. Every request appears to come from the same IP → rate limiter useless. Fix: `app.set('trust proxy', 1)` (or more specific trust list) so Express trusts the forwarded headers.

### Bug 10 — Logger leaks request body

```js
app.use(express.json());
app.use(morgan(':method :url :req[body]'));   // logs request body
```

Combined with password endpoints, this writes passwords to logs. Either log only metadata, or set up format that excludes sensitive routes.

## Diagnostic snippet

Drop this in to print the registered middleware chain (helpful for code review):

```js
app._router?.stack.forEach((layer, i) => {
  console.log(i, layer.name || '<anon>', layer.regexp?.toString() || '');
});
```

Run it after `app.use(...)` calls but before `listen` — confirms middleware is in expected order.

## Order checklist for the audit report

1. Trust proxy set (if applicable)
2. Helmet first
3. CORS / rate limit before body parsing
4. Body parsers with size limits
5. Cookie parser before session
6. Session before CSRF
7. Auth middleware before protected routes
8. Routes after global middleware
9. 404 handler
10. Error handler last, with 4 args

For each bug class above, search the project's main app file and any sub-routers — bugs often hide in sub-routers that re-mount middleware in inconsistent order.
