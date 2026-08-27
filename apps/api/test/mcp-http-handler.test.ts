import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { makeMcpHttpHandler, sweepIdleSessions } from "../../../apps/mcp/src/http-handler.js";

// S2-H4: the MCP HTTP auth check (bearerOk) issues a DB query for non-boot tokens.
// If that rejects, the handler must degrade to a sanitized 500 — not escape as an
// unhandledRejection that hangs the socket / can tear down the long-lived process.
function fakeRes() {
  return {
    statusCode: 0,
    headersSent: false,
    writeHead(code: number) {
      this.statusCode = code;
      this.headersSent = true;
      return this;
    },
    end() {},
  };
}

describe("MCP HTTP handler — auth errors degrade to 500 (S2-H4)", () => {
  it("a throwing bearerOk yields a 500 and never rejects", async () => {
    const handler = makeMcpHttpHandler({
      httpPath: "/mcp",
      bearerOk: async () => {
        throw new Error("DB connection refused");
      },
      buildServer: () => {
        throw new Error("should not be reached");
      },
      sessions: new Map(),
      lastSeen: new Map(),
    });
    const res = fakeRes();
    await expect(
      handler({ url: "/mcp", headers: {} } as unknown as IncomingMessage, res as unknown as ServerResponse),
    ).resolves.toBeUndefined();
    expect(res.statusCode).toBe(500);
  });

  it("a non-matching path still 404s without invoking auth", async () => {
    const handler = makeMcpHttpHandler({
      httpPath: "/mcp",
      bearerOk: async () => {
        throw new Error("auth should not run for the wrong path");
      },
      buildServer: () => {
        throw new Error("nope");
      },
      sessions: new Map(),
      lastSeen: new Map(),
    });
    const res = fakeRes();
    await handler({ url: "/other", headers: {} } as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(404);
  });
});

describe("sweepIdleSessions", () => {
  const mk = () => { let closed = false; return { close: () => { closed = true; }, get closed() { return closed; } }; };
  it("closes sessions idle beyond the window, keeps recent ones", () => {
    const a = mk(), b = mk();
    const sessions = new Map<string, typeof a>([["a", a], ["b", b]]);
    const lastSeen = new Map<string, number>([["a", 0], ["b", 9_000]]);
    const closed = sweepIdleSessions(sessions, lastSeen, 10_000, 5_000, 100);
    expect(closed).toBe(1);
    expect(sessions.has("a")).toBe(false); // idle 10s > 5s window → closed
    expect(a.closed).toBe(true);
    expect(sessions.has("b")).toBe(true);  // idle 1s → kept
    expect(lastSeen.has("a")).toBe(false);
  });
  it("evicts the oldest-seen down to the ceiling", () => {
    const s = new Map(Array.from({ length: 5 }, (_, i) => [`s${i}`, mk()] as const));
    const lastSeen = new Map(Array.from({ length: 5 }, (_, i) => [`s${i}`, i * 1000] as const));
    const closed = sweepIdleSessions(s, lastSeen, 4000, 60_000, 3); // idle window not hit; cap=3
    expect(closed).toBe(2);
    expect(s.has("s0")).toBe(false); // oldest two evicted
    expect(s.has("s1")).toBe(false);
    expect(s.size).toBe(3);
  });
});
