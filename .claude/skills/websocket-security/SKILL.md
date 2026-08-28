---
name: websocket-security
description: Security audit for WebSocket implementations including auth on connection upgrade, origin validation, per-message authorization, rate limiting, message size limits, broadcast scoping, and library-specific patterns (ws, socket.io, uWebSockets, Phoenix Channels, SignalR). Use this skill whenever the user mentions WebSocket, ws, socket.io, Socket.IO, websockets library, uWebSockets, Phoenix Channels, SignalR, wss://, or asks "audit my WebSocket", "Socket.IO security", "WebSocket auth". Trigger when the codebase contains `ws`, `socket.io`, `socket.io-client`, `@socket.io/*`, or WebSocket-related code.
---

# WebSocket Security Audit

Audit WebSocket implementations. WebSocket auth and authz are different from REST — auth happens once at the upgrade, but messages flow continuously.

## When this skill applies

- Reviewing WebSocket server setup (ws, socket.io, etc.)
- Auditing the connection upgrade handler for auth
- Reviewing per-message authorization
- Checking broadcast / room scoping
- Reviewing message size and rate limits

## Workflow

Follow `../_shared/audit-workflow.md`.

### Phase 1: Stack detection

```bash
grep -E '"(ws|socket\.io|@socket\.io|uWebSockets\.js|@nestjs/websockets)":' package.json
# Phoenix Channels
grep -E 'phoenix' mix.exs 2>/dev/null
# SignalR
grep -nE 'Microsoft\.AspNetCore\.SignalR' *.csproj 2>/dev/null
```

### Phase 2: Inventory

```bash
# Server setup
grep -rn 'new WebSocketServer\|new Server\|io =\|WebSocketServer(' src/

# Connection / message handlers
grep -rn '\.on(.connection.\|\.on(.message.\|handleConnection\|@SubscribeMessage' src/

# Auth in upgrade
grep -rn 'handleUpgrade\|verifyClient\|allowRequest' src/

# Broadcast / rooms
grep -rn 'broadcast\|\.to(\|\.in(\|emit(' src/
```

### Phase 3: Detection — the checks

#### Auth on connection upgrade

WebSocket upgrade is HTTP. Auth happens here, not after.

- **WSC-AUTH-1** Connection handler verifies auth BEFORE accepting the upgrade.
  ```ts
  // ws library
  wss.on('connection', (ws, req) => {
    // BAD — verify auth INSIDE here means upgrade already succeeded
    if (!req.headers.cookie) ws.close();
  });
  
  // GOOD — verify in upgrade handler
  const server = http.createServer();
  server.on('upgrade', async (req, socket, head) => {
    const user = await authenticate(req);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as any).user = user;
      wss.emit('connection', ws, req);
    });
  });
  ```
- **WSC-AUTH-2** Token-based auth: token from query string is OK but logged in access logs (leaks). Better: in `Sec-WebSocket-Protocol` header or cookie.
- **WSC-AUTH-3** Cookie-based auth: same-origin restrictions enforced.

#### Origin validation

WebSocket doesn't have same-origin policy. Origin header check at upgrade is the defense.

- **WSC-ORI-1** Upgrade handler checks `req.headers.origin` against an allowlist. Without this, any origin can open a WebSocket (cross-site WebSocket hijacking).
- **WSC-ORI-2** `ws` library: `verifyClient: (info, cb) => { if (allowed(info.origin)) cb(true); else cb(false, 403, 'Origin'); }`
- **WSC-ORI-3** socket.io: `cors: { origin: ['...'], credentials: true }`.

#### Per-message authorization

After connection, every message might trigger sensitive ops. Auth resolved at upgrade isn't enough.

- **WSC-MSG-1** Each message handler verifies the authenticated user can perform the action.
  ```ts
  ws.on('message', async (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'delete_post') {
      const post = await db.posts.findById(msg.postId);
      if (post.authorId !== ws.user.id) return ws.send(JSON.stringify({ error: 'Forbidden' }));
      await db.posts.delete(msg.postId);
    }
  });
  ```
- **WSC-MSG-2** Don't trust message fields naming users/tenants — derive from `ws.user`.

#### Message validation

- **WSC-VAL-1** Incoming messages validated against a schema (Zod, AJV, ajv-formats).
- **WSC-VAL-2** Unknown message types rejected (don't fail silently — log/disconnect on protocol abuse).
- **WSC-VAL-3** `JSON.parse` wrapped in try/catch; malformed JSON doesn't crash.

#### Message size limits

- **WSC-SIZE-1** `maxPayload` configured (ws library): `new WebSocketServer({ maxPayload: 64 * 1024 })` — 64KB or appropriate.
- **WSC-SIZE-2** Per-connection message rate limit (sliding window).
- **WSC-SIZE-3** Backpressure handling: if client can't keep up with server writes, close rather than queue indefinitely.

#### Broadcast / room scoping

- **WSC-BC-1** `io.emit(...)` broadcasts to all connected clients — never carries per-user data.
- **WSC-BC-2** Room membership controlled by server, not by client request. Clients can't `socket.join(otherUserRoom)` arbitrarily.
- **WSC-BC-3** Messages emitted to rooms confirm room identity matches the sender's allowed scope.

```ts
// BAD — client tells server which room to join
socket.on('joinRoom', (room) => socket.join(room));  // attacker: joinRoom('admin')

// GOOD — server determines rooms
socket.join(`user-${socket.user.id}`);
socket.join(`tenant-${socket.user.tenantId}`);
```

#### Connection lifecycle

- **WSC-LC-1** Auth changes (logout, token revocation) close active WebSocket connections — long-lived sockets bypass token expiry otherwise.
- **WSC-LC-2** Periodic ping/pong with timeout; dead connections cleaned up to prevent resource leak.
- **WSC-LC-3** Connection count per user / per IP capped.

#### Socket.IO specifics

- **WSC-SIO-1** `socket.handshake.auth` for token-based auth (sent at connect, not in query string).
- **WSC-SIO-2** Middleware applied to each namespace (`io.of('/admin').use(authMw)`).
- **WSC-SIO-3** `socket.io` adapter (Redis) configured for multi-instance broadcast; broadcast not leaking across tenants in shared adapter.
- **WSC-SIO-4** `cors` configured (default 4.x is `disabled`).

#### NestJS WebSockets (@nestjs/websockets)

- **WSC-NST-1** `@WebSocketGateway` with `cors: { origin: [...] }`.
- **WSC-NST-2** Gateway `handleConnection(client)` extracts auth, attaches to client.
- **WSC-NST-3** `@SubscribeMessage('event')` handlers use guards: `@UseGuards(WsAuthGuard)`.

#### Phoenix Channels (Elixir)

- **WSC-PX-1** `join/3` callback authenticates and authorizes topic membership.
- **WSC-PX-2** `socket.connect/3` handles auth from connect params.

#### SignalR (.NET)

- **WSC-SR-1** Hub methods annotated with `[Authorize]`.
- **WSC-SR-2** `Context.User` validated; per-call authz checks on resource access.

#### TLS

- **WSC-TLS-1** Production WebSocket endpoint uses `wss://` (TLS). Never plain `ws://` on the public internet.

#### Logging

- **WSC-LOG-1** Connection events logged with user ID; disconnects logged with reason.
- **WSC-LOG-2** Message contents not logged at info level (PII / secrets).

#### Dependencies

- **WSC-DEP-1** `ws` >= 8.x (older CVEs around frame parsing); `socket.io` >= 4.x.

### Phase 4: Triage

Critical: missing origin check at upgrade; client controls room/channel join; per-message authz absent; no message size limit (DoS).

### Phase 5: Report

Use `../_shared/findings-schema.md`. Prefix IDs with `WSC-`.
