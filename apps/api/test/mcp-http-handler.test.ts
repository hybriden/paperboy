import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { makeMcpHttpHandler } from "../../../apps/mcp/src/http-handler.js";

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
    });
    const res = fakeRes();
    await handler({ url: "/other", headers: {} } as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(404);
  });
});
