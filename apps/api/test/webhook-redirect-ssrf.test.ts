import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postFollowingRedirectsSafely } from "@paperboy/db";

/**
 * Webhook dispatch followed redirects.
 *
 * `assertPublicWebhookUrl` is called at create time AND again at dispatch (closing
 * DNS rebinding), but the actual `fetch` took undici's default `redirect: "follow"`.
 * So an allowlisted public host could answer 302 → http://169.254.169.254/… and the
 * server would obediently POST there: the pre-fetch host check guards nothing once
 * the transport follows hops on its own. Worse, the response status is persisted on
 * the webhook row and readable via listWebhooks, making it a blind scan oracle for
 * hosts inside the deployment network.
 *
 * packages/db/src/stock.ts already solved exactly this for image downloads by
 * following hops MANUALLY and re-checking each host; this pins the same discipline
 * for webhooks. The check predicate is injected so the test can make hop 1 legal
 * and hop 2 internal without controlling DNS.
 */
describe("webhook dispatch — redirects are re-validated per hop", () => {
  let server: Server;
  let base: string;
  const seen: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.url ?? "");
      if (req.url === "/redirect-to-metadata") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
        return;
      }
      if (req.url === "/redirect-chain") {
        res.writeHead(302, { location: "/ok" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** Mirrors the real guard's verdict: loopback allowed here, link-local never. */
  const assertAllowed = async (url: string): Promise<void> => {
    const host = new URL(url).hostname;
    if (host.startsWith("169.254.") || host === "::1") {
      throw new Error(`blocked internal host ${host}`);
    }
  };

  it("refuses to follow a 302 into the cloud metadata endpoint", async () => {
    await expect(
      postFollowingRedirectsSafely(`${base}/redirect-to-metadata`, { method: "POST", body: "{}" }, assertAllowed),
    ).rejects.toThrow(/169\.254|blocked/i);
  });

  it("still follows a legitimate same-host redirect", async () => {
    const res = await postFollowingRedirectsSafely(
      `${base}/redirect-chain`,
      { method: "POST", body: "{}" },
      assertAllowed,
    );
    expect(res.status).toBe(200);
  });

  it("bounds the hop count instead of looping forever", async () => {
    const loop = createServer((_req, res) => {
      res.writeHead(302, { location: "/again" });
      res.end();
    });
    await new Promise<void>((r) => loop.listen(0, "127.0.0.1", r));
    const loopBase = `http://127.0.0.1:${(loop.address() as AddressInfo).port}`;
    try {
      await expect(
        postFollowingRedirectsSafely(`${loopBase}/again`, { method: "POST", body: "{}" }, assertAllowed),
      ).rejects.toThrow(/redirect/i);
    } finally {
      await new Promise<void>((r) => loop.close(() => r()));
    }
  });

  it("rejects a 3xx with no Location rather than treating it as success", async () => {
    const bare = createServer((_req, res) => {
      res.writeHead(302);
      res.end();
    });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    const bareBase = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    try {
      await expect(
        postFollowingRedirectsSafely(`${bareBase}/x`, { method: "POST", body: "{}" }, assertAllowed),
      ).rejects.toThrow(/location/i);
    } finally {
      await new Promise<void>((r) => bare.close(() => r()));
    }
  });
});
