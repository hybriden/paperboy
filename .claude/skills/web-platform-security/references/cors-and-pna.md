# CORS and Private Network Access — Deep Dive

Authoritative sources:
- web.dev — [Cross-origin resource sharing](https://web.dev/articles/cross-origin-resource-sharing)
- web.dev — [Private Network Access: introducing preflights](https://developer.chrome.com/blog/private-network-access-preflight)
- WHATWG Fetch — [CORS protocol](https://fetch.spec.whatwg.org/#http-cors-protocol)
- WHATWG Fetch — [Private Network Access](https://wicg.github.io/private-network-access/)

## The model in three sentences

A browser request is *cross-origin* when scheme + host + port differ from the page that initiated it. Cross-origin reads are blocked by default; the server opts in by returning CORS headers. For requests carrying credentials (cookies, HTTP auth, client certs), the rules tighten: `Allow-Origin` must echo a single concrete origin (not `*`) and `Allow-Credentials: true` must accompany it.

## The four headers that matter

| Response header | Purpose |
|-----------------|---------|
| `Access-Control-Allow-Origin` | Which origins may read the response |
| `Access-Control-Allow-Credentials` | Whether cookies / auth headers are allowed |
| `Access-Control-Allow-Methods` | Which methods are allowed (preflight) |
| `Access-Control-Allow-Headers` | Which request headers are allowed (preflight) |

Plus the response-exposing header:

| `Access-Control-Expose-Headers` | Which response headers the JS can READ (defaults to a small safelist) |

## Simple vs preflighted requests

The Fetch spec defines "simple" requests that skip the preflight:
- Methods: `GET`, `HEAD`, `POST`
- Headers: only CORS-safelisted (`Accept`, `Accept-Language`, `Content-Language`, `Content-Type` with limited values, `Range` for byte ranges)
- `Content-Type` limited to `application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`
- No `ReadableStream` body, no event-listener gymnastics

Anything else triggers an `OPTIONS` preflight first. The server answers the preflight with `Allow-Methods` and `Allow-Headers`; the browser then sends the real request.

Cache the preflight result with `Access-Control-Max-Age` (seconds). Reasonable values: 600 (10 min) to 86400 (24 h). Firefox caps at 86400; Chrome caps at 7200 (2 h).

## Allowlist pattern (canonical)

```ts
const ALLOWED_ORIGINS = new Set([
  'https://app.example.com',
  'https://staging.example.com',
  'https://admin.example.com',
]);

function corsMiddleware(req: Request, res: Response, next: () => void) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');                         // cache correctness
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Request-Id');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }
  next();
}
```

Critical lines:
- `Vary: Origin` — without it, a CDN may serve a response with `Allow-Origin: https://a.example.com` to a request from `https://b.example.com`.
- `Allow-Credentials: true` ONLY when the origin matched the allowlist. Don't blanket-set it.
- Preflight returns 204 with no body. Returning 200 + body works but wastes bytes.

## Safe subdomain wildcard

If you genuinely need `*.example.com`, parse and check — don't regex:

```ts
const ALLOWED_HOST_SUFFIXES = ['.example.com'];
function isAllowed(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:') return false;
    return ALLOWED_HOST_SUFFIXES.some(suffix => 
      u.hostname === suffix.slice(1) || u.hostname.endsWith(suffix)
    );
  } catch { return false; }
}
```

Regex like `/example\.com$/` matches `https://evil-example.com`. Always parse the origin into a URL first.

## Five anti-patterns

### 1. `*` with credentials

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Credentials: true
```

Browsers reject this combination by spec — credentialed fetches stop working. The intent is the smell: someone wanted both, which means they don't understand the model.

### 2. Reflected `Origin`

```js
// CRITICAL
res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
res.setHeader('Access-Control-Allow-Credentials', 'true');
```

Echoes whatever the attacker sets. Any site can read the authenticated response via `fetch(..., {credentials: 'include'})`. This is a credential-bound data exfiltration primitive.

### 3. Localhost in the production allowlist

```ts
const ALLOWED = ['https://app.example.com', 'http://localhost:3000'];
```

`Origin: http://localhost:3000` is a string the attacker sets in their server-side fetch — production should never special-case localhost.

### 4. Wildcard methods/headers on credentialed APIs

`Access-Control-Allow-Methods: *` and `Access-Control-Allow-Headers: *` were added to the spec but DO NOT apply to credentialed requests. For credentialed APIs, list explicitly.

### 5. Preflight returns 200 with body

```
HTTP/1.1 200 OK
Content-Type: text/html
<...>
```

Preflight should be 204 with CORS headers, no body. A 200 + body costs bytes and confuses caches.

## Verifying CORS from the command line

```bash
# Should succeed — allowed origin
curl -sI -X OPTIONS \
  -H 'Origin: https://app.example.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,authorization' \
  https://api.example.com/v1/users \
  | grep -i 'access-control'

# Should fail — disallowed origin
curl -sI -X OPTIONS \
  -H 'Origin: https://attacker.example' \
  -H 'Access-Control-Request-Method: POST' \
  https://api.example.com/v1/users \
  | grep -i 'access-control'
```

If the second `curl` returns CORS headers, the server is over-permissive.

## CORS vs CSRF

CORS protects who can READ responses. CSRF protects against unwanted state-changing requests being made on behalf of the user.

- A strict CORS policy does NOT replace CSRF defenses on cookie-authenticated endpoints.
- `SameSite=Lax` (now default) mitigates most CSRF on POST/PUT/DELETE. CSRF tokens cover the rest.
- For Bearer-token APIs, CORS is the primary defense — no ambient cookie, attacker needs to read the response.

See `cookies-modern.md` for the cookie side.

## Private Network Access (PNA)

PNA is Chrome's policy that a request from a "public" page (https/http on a routable address) to a "private" address (RFC1918, link-local, loopback) sends a CORS preflight asking permission.

### Address-space classification

| Address space | Examples |
|---------------|----------|
| `local` | 127.0.0.0/8, ::1 |
| `private` | RFC1918 (10.0.0.0/8, 172.16/12, 192.168/16), link-local (169.254/16), unique-local v6 (fc00::/7) |
| `public` | Everything else (including most cloud IPs, public DNS) |

A `public` → `private` request triggers a preflight, even for "simple" requests that wouldn't otherwise preflight.

### The preflight

```http
OPTIONS /admin HTTP/1.1
Host: 192.168.1.10
Origin: https://app.example.com
Access-Control-Request-Method: POST
Access-Control-Request-Private-Network: true
```

The server must respond with:

```http
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Methods: POST
Access-Control-Allow-Private-Network: true
Access-Control-Allow-Credentials: true   # if the request used credentials
```

Without `Access-Control-Allow-Private-Network: true`, Chrome blocks the request.

### Who this affects

- Web apps that talk to LAN devices (printers, routers, IoT controllers, home assistants)
- Localhost-talking dev tooling (a public web app instructing a `localhost:` daemon)
- Internal admin tools loaded over the public internet that hit private-IP backends (bad idea anyway — they should be behind a VPN, not exposed)

### Mitigation in your servers

If you operate the private-network endpoint:

```ts
// Express middleware example
app.use((req, res, next) => {
  if (req.method === 'OPTIONS' && req.headers['access-control-request-private-network'] === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    return res.status(204).end();
  }
  next();
});
```

### Rollout state

Chrome's enforcement has been staged: warning-only → enforcement in some contexts → broader enforcement. The Chrome status entry is the source of truth — check before deploying anything that relies on a particular timeline.

## Audit checklist

For each public API endpoint:

1. `Allow-Origin` is set per-request to a specific origin OR absent if the origin isn't allowed.
2. `Vary: Origin` is set whenever CORS headers vary by origin.
3. `Allow-Credentials: true` appears only with a specific origin.
4. Preflight returns 204 with appropriate methods/headers and a sane `Max-Age`.
5. No `*` for credentialed APIs anywhere.
6. Subdomain wildcards (if any) are implemented via URL parsing, not regex.
7. PNA preflight handled correctly for any endpoint on a private IP that's reachable from public pages.
