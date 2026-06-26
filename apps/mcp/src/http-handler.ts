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
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) deps.sessions.delete(transport.sessionId);
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
