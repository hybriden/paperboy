import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";
import { type EmbeddedMcp, startEmbeddedMcp } from "../src/mcp-embedded.js";
import { ORIGIN, type Suite, TEST_DB, setupApi } from "./helpers.js";

/**
 * MCP_EMBEDDED: a one-container host (App Service) has no second service for
 * the MCP server, so the API runs it as a child and forwards /mcp to it. These
 * drive the REAL apps/mcp server through the API's /mcp, the way a remote MCP
 * client reaches it.
 */

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

/** POST /mcp with no credential until the MCP server answers (502 = not up yet). */
async function waitForMcp(base: string): Promise<Response> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (res.status !== 502) return res;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("embedded MCP server never answered");
}

describe("MCP_EMBEDDED config", () => {
  it("points /mcp at the embedded server", () => {
    const env = loadEnv({ DATABASE_URL: TEST_DB, NODE_ENV: "test", MCP_EMBEDDED: "true" });
    expect(env.MCP_UPSTREAM_URL).toBe("http://127.0.0.1:8093");
  });

  it("refuses to start when MCP_UPSTREAM_URL also names a separate MCP service", () => {
    expect(() => loadEnv({ DATABASE_URL: TEST_DB, NODE_ENV: "test", MCP_EMBEDDED: "true", MCP_UPSTREAM_URL: "http://mcp:8093" })).toThrow(
      /Unset one/,
    );
  });
});

describe("embedded MCP server behind /mcp", () => {
  let suite: Suite;
  let base: string;
  let mcp: EmbeddedMcp;

  beforeAll(async () => {
    const port = await freePort();
    suite = await setupApi({ MCP_UPSTREAM_URL: `http://127.0.0.1:${port}` });
    mcp = startEmbeddedMcp({ port, publicUrl: ORIGIN, log: suite.app.log, env: { ...process.env, DATABASE_URL: TEST_DB }, restartDelayMs: 200 });
    base = await suite.app.listen({ port: 0, host: "127.0.0.1" });
  }, 120_000);

  afterAll(async () => {
    mcp.stop();
    await suite.app.close();
  });

  it("answers /mcp as the real MCP server, with the OAuth challenge clients sign in from", async () => {
    const res = await waitForMcp(base);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource`);
  }, 120_000);

  it("restarts the MCP server after it dies", async () => {
    const crashed = mcp.current()!;
    crashed.kill("SIGKILL");
    await new Promise((r) => crashed.once("exit", r));
    const deadline = Date.now() + 10_000;
    while (!mcp.current() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(mcp.current()?.pid).not.toBe(crashed.pid);
    expect((await waitForMcp(base)).status).toBe(401);
  }, 120_000);
});
