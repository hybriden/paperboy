import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

interface Received {
  event: string;
  signature: string;
  body: string;
}

/** A throwaway HTTP server that records the webhook deliveries it receives. */
function startStub(): Promise<{ server: Server; url: string; received: Received[] }> {
  const received: Received[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({
          event: String(req.headers["x-paperboy-event"] ?? ""),
          signature: String(req.headers["x-paperboy-signature"] ?? ""),
          body,
        });
        res.writeHead(200).end("ok");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/hook`, received });
    });
  });
}

describe("Webhooks (HMAC-signed publish events)", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let editor: Awaited<ReturnType<typeof login>>;
  let stub: Awaited<ReturnType<typeof startStub>>;
  let secret: string;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    editor = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    stub = await startStub();
    const create = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/webhooks",
      headers: authHeaders(admin),
      payload: { name: "stub", url: stub.url, events: ["content.published"] },
    });
    expect(create.statusCode).toBe(200);
    secret = create.json().secret;
    expect(secret).toMatch(/^whsec_/);
  });
  afterAll(async () => {
    await s.app.close();
    stub.server.close();
  });

  it("requires webhook.manage to register (editor forbidden)", async () => {
    const res = await s.app.inject({ method: "POST", url: "/api/v1/manage/webhooks", headers: authHeaders(editor), payload: { name: "x", url: "https://example.com/h" } });
    expect(res.statusCode).toBe(403);
  });

  it("delivers an HMAC-signed content.published event when a page is published", async () => {
    const before = stub.received.length;
    // Create + publish a page (Editor).
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(editor), payload: { type: "StandardPage", locale: "en", name: "Hooked" } });
    const id = created.json().documentId;
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(editor), payload: { name: "Hooked", slug: "hooked", data: { heading: "Hooked" } } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(editor) });

    // Dispatch is fire-and-forget — poll briefly for receipt.
    const deadline = Date.now() + 3000;
    while (stub.received.length <= before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(stub.received.length).toBeGreaterThan(before);
    const hit = stub.received[stub.received.length - 1]!;
    expect(hit.event).toBe("content.published");

    // Signature verifies with the subscription secret.
    const expected = `sha256=${createHmac("sha256", secret).update(hit.body).digest("hex")}`;
    expect(hit.signature).toBe(expected);
    const payload = JSON.parse(hit.body);
    expect(payload.documentId).toBe(id);
    expect(payload.type).toBe("StandardPage");
    expect(payload.urlPath).toBe("/hooked");
  });

  it("lists webhooks without exposing the secret", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/webhooks", headers: authHeaders(admin) });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).not.toHaveProperty("secret");
  });
});
