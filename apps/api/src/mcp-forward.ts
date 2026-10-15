import { type IncomingHttpHeaders, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Forward /mcp to the MCP server (MCP_UPSTREAM_URL), so the remote MCP endpoint
 * lives at {PUBLIC_URL}/mcp on the same domain as the admin and the API — the
 * default MCP_PUBLIC_URL, and the OAuth resource tokens are issued for.
 *
 * A plain byte pipe: the MCP server authenticates every request itself (OAuth or
 * a minted token), parses and size-limits its own bodies, and Streamable HTTP may
 * hold a response open as SSE — so nothing here buffers, parses or authorizes.
 */

// Per-connection headers (RFC 9110 §7.6.1) belong to one hop and are not forwarded.
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);

function withoutHopByHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name)));
}

export async function registerMcpForward(app: FastifyInstance, upstreamUrl: string): Promise<void> {
  const target = new URL(upstreamUrl);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;

  const forward = (req: FastifyRequest, reply: FastifyReply): void => {
    reply.hijack();
    const res = reply.raw;
    const headers = withoutHopByHop(req.headers);
    // The public Host stays as sent; the client address is appended to the chain.
    headers["x-forwarded-for"] = [req.headers["x-forwarded-for"], req.socket.remoteAddress].filter(Boolean).join(", ");
    headers["x-forwarded-proto"] = req.protocol;

    const upstream = send(
      { protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, withoutHopByHop(upstreamRes.headers));
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      req.log.warn({ err, upstream: upstreamUrl }, "MCP upstream unreachable");
      if (res.headersSent) return void res.destroy();
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "mcp_unavailable",
          message: "The MCP server behind this endpoint is not answering. Start it (docker compose --profile mcp up -d mcp), or unset MCP_UPSTREAM_URL if this instance serves no remote MCP.",
        }),
      );
    });
    // The client went away (or the response finished): stop the upstream side too.
    res.on("close", () => upstream.destroy());
    req.raw.pipe(upstream);
  };

  await app.register(async (scope) => {
    // Leave every body unread so it streams through to the MCP server as sent.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, _payload, done) => done(null));
    scope.route({
      method: ["GET", "POST", "DELETE"],
      url: "/mcp",
      schema: { hide: true },
      // Remote MCP clients reach us from shared egress IPs (a hosted assistant
      // serves many users from a few addresses), and nginx never limited this
      // route either. The MCP server authenticates every request itself.
      config: { rateLimit: false },
      handler: forward,
    });
  });
}
