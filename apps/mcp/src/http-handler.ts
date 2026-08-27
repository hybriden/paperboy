import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface McpHttpDeps {
  httpPath: string;
  /** Resolve true if the request is authorized. May reject (e.g. a DB error). */
  bearerOk: (req: IncomingMessage) => Promise<boolean>;
  buildServer: () => McpServer;
  sessions: Map<string, StreamableHTTPServerTransport>;
  /** Last-touched timestamp per session id, for the idle sweep. */
  lastSeen: Map<string, number>;
}

const json = (res: ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}): void => {
  res.writeHead(code, { "content-type": "application/json", ...extra });
  res.end(JSON.stringify(body));
};

/**
 * The Streamable-HTTP request handler for the MCP server, extracted so it is
 * testable without booting the process. Every awaited step that can reject —
 * including the `bearerOk` auth check, which issues a DB query for non-boot
 * tokens — MUST run inside the try/catch so a transient fault degrades to a
 * sanitized 500 instead of escaping as an unhandledRejection (which, on this
 * long-lived remote process, can hang the client socket or tear the process down).
 */
export function makeMcpHttpHandler(deps: McpHttpDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health") {
      json(res, 200, { ok: true });
      return;
    }
    if (path !== deps.httpPath) {
      json(res, 404, { error: "not found" });
      return;
    }
    try {
      if (!(await deps.bearerOk(req))) {
        json(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
        return;
      }
      const sid = req.headers["mcp-session-id"];
      const existing = typeof sid === "string" ? deps.sessions.get(sid) : undefined;
      if (existing) {
        deps.lastSeen.set(sid as string, Date.now());
        await existing.handleRequest(req, res);
        return;
      }
      // No known session → start a new one (the request must be `initialize`;
      // the transport replies with the right JSON-RPC error otherwise).
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          deps.sessions.set(id, transport);
          deps.lastSeen.set(id, Date.now());
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          deps.sessions.delete(transport.sessionId);
          deps.lastSeen.delete(transport.sessionId);
        }
      };
      const reqServer = deps.buildServer();
      await reqServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[paperboy-mcp] request error:", err);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    }
  };
}

/**
 * Close sessions idle beyond `idleMs`, then evict oldest-seen down to
 * `maxSessions`. The Map is only pruned on a client's explicit DELETE
 * (transport.onclose), so a client that crashes without one would otherwise
 * leak a transport + McpServer forever on this long-lived process. Pure and
 * time-injected so it is unit-testable; the process runs it on an interval.
 */
export function sweepIdleSessions<T extends { close?: () => unknown }>(
  sessions: Map<string, T>,
  lastSeen: Map<string, number>,
  now: number,
  idleMs: number,
  maxSessions: number,
): number {
  let closed = 0;
  const drop = (id: string): void => {
    const t = sessions.get(id);
    try {
      void t?.close?.();
    } catch {
      /* closing a dead transport must not throw the sweep */
    }
    sessions.delete(id);
    lastSeen.delete(id);
    closed++;
  };
  // Deleting a Map entry during keys() iteration is spec-safe: the current key
  // is not revisited and an unvisited deleted key is skipped — no snapshot needed.
  for (const id of sessions.keys()) {
    if (now - (lastSeen.get(id) ?? 0) > idleMs) drop(id);
  }
  if (sessions.size > maxSessions) {
    const oldestFirst = [...sessions.keys()].sort((a, b) => (lastSeen.get(a) ?? 0) - (lastSeen.get(b) ?? 0));
    for (const id of oldestFirst.slice(0, sessions.size - maxSessions)) drop(id);
  }
  return closed;
}
