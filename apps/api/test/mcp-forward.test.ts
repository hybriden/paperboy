import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, setupApi } from "./helpers.js";

/**
 * With MCP_UPSTREAM_URL set, the API forwards /mcp to the MCP server, so the
 * remote MCP endpoint keeps living at {PUBLIC_URL}/mcp on the one domain — the
 * route the admin's nginx used to provide. Streamable HTTP holds responses open
 * (SSE), so the forward must stream, not buffer.
 */
interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let upstream: Server;
let upstreamUrl: string;
let seen: Seen[] = [];
let releaseStream: (() => void) | null = null;

function onUpstream(req: IncomingMessage, res: ServerResponse): void {
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", () => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    if (req.method === "GET") {
      // An SSE stream that stays open until the test releases it.
      res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sess-1" });
      res.write("event: message\ndata: first\n\n");
      releaseStream = () => res.end("event: message\ndata: last\n\n");
      return;
    }
    if (req.headers.authorization !== "Bearer good") {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="x"` });
      res.end(`{"error":"unauthorized"}`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
    res.end(JSON.stringify({ echoed: body }));
  });
}

let suite: Suite;
let base: string;
beforeAll(async () => {
  upstream = createServer(onUpstream);
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  suite = await setupApi({ MCP_UPSTREAM_URL: upstreamUrl });
  base = await suite.app.listen({ port: 0, host: "127.0.0.1" });
});
afterAll(async () => {
  releaseStream?.();
  await suite.app.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe("/mcp forwarding", () => {
  it("forwards method, path, query, body and the MCP headers, and returns the upstream response", async () => {
    seen = [];
    const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const res = await fetch(`${base}/mcp?x=1`, {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json", "mcp-protocol-version": "2025-06-18", accept: "application/json, text/event-stream" },
      body: rpc,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBe("sess-1");
    expect(await res.json()).toEqual({ echoed: rpc });
    expect(seen).toHaveLength(1);
    const got = seen[0]!;
    expect(got.method).toBe("POST");
    expect(got.url).toBe("/mcp?x=1");
    expect(got.body).toBe(rpc);
    expect(got.headers.authorization).toBe("Bearer good");
    expect(got.headers["mcp-protocol-version"]).toBe("2025-06-18");
    // The public host is preserved, and the client address is appended.
    expect(got.headers.host).toBe(new URL(base).host);
    expect(got.headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(got.headers["x-forwarded-proto"]).toBe("http");
  });

  it("passes an upstream 401 and its WWW-Authenticate challenge through (OAuth discovery depends on it)", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="x"`);
  });

  it("streams a held-open SSE response instead of buffering it", async () => {
    const res = await fetch(`${base}/mcp`, { method: "GET", headers: { accept: "text/event-stream" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    // The first event must arrive while the upstream is still holding the stream open.
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("data: first");
    releaseStream!();
    let rest = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += new TextDecoder().decode(chunk.value);
    expect(rest).toContain("data: last");
  });

});

describe("/mcp and the API rate limit", () => {
  it("is not counted against the per-IP limit (remote MCP clients share egress IPs)", async () => {
    // NODE_ENV=test lifts the limit out of reach, so build a development app
    // with a limit of 2 to see where it applies.
    const limited = await setupApi({ NODE_ENV: "development", RATE_LIMIT_MAX: "2", MCP_UPSTREAM_URL: upstreamUrl });
    try {
      for (let i = 0; i < 4; i++) {
        const res = await limited.app.inject({ method: "POST", url: "/mcp", headers: { authorization: "Bearer good" }, payload: {} });
        expect(res.statusCode).toBe(200);
      }
      // The limit itself is still in force for the API.
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) codes.push((await limited.app.inject({ method: "GET", url: "/health" })).statusCode);
      expect(codes).toContain(429);
    } finally {
      await limited.app.close();
    }
  });
});

describe("/mcp forwarding with the MCP server down", () => {
  let down: Suite;
  beforeAll(async () => {
    // A port nothing listens on.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    down = await setupApi({ MCP_UPSTREAM_URL: `http://127.0.0.1:${port}` });
  });
  afterAll(async () => {
    await down.app.close();
  });

  it("answers 502 with a self-teaching JSON error", async () => {
    const res = await down.app.inject({ method: "POST", url: "/mcp", payload: {} });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "mcp_unavailable" });
    expect(res.json().message).toMatch(/MCP_UPSTREAM_URL/);
  });
});

describe("/mcp without MCP_UPSTREAM_URL", () => {
  it("is not routed at all", async () => {
    const plain = await setupApi();
    try {
      const res = await plain.app.inject({ method: "POST", url: "/mcp", payload: {} });
      expect(res.statusCode).toBe(404);
    } finally {
      await plain.app.close();
    }
  });
});
