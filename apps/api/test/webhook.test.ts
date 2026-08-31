import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchWebhooks } from "@paperboy/db";
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
  const savedPrivateFlag = process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE;

  beforeAll(async () => {
    // This suite delivers to a loopback stub server — allow private targets.
    process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE = "true";
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
    if (savedPrivateFlag === undefined) delete process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE;
    else process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE = savedPrivateFlag;
  });

  it("requires webhook.manage to register (editor forbidden)", async () => {
    const res = await s.app.inject({ method: "POST", url: "/api/v1/manage/webhooks", headers: authHeaders(editor), payload: { name: "x", url: "https://example.com/h" } });
    expect(res.statusCode).toBe(403);
  });

  it("delivers an HMAC-signed content.published event when a page is published", async () => {
    const before = stub.received.length;
    // Create + publish a page (Editor).
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(editor), payload: { type: "ArticlePage", locale: "en", name: "Hooked" } });
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
    expect(payload.type).toBe("ArticlePage");
    expect(payload.urlPath).toBe("/hooked");
  });

  it("deleting an unknown (or another site's) webhook id is a 404, not a silent success", async () => {
    const res = await s.app.inject({ method: "DELETE", url: "/api/v1/manage/webhooks/999999", headers: authHeaders(admin) });
    expect(res.statusCode, res.body).toBe(404);
  });

  it("lists webhooks without exposing the secret", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/webhooks", headers: authHeaders(admin) });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).not.toHaveProperty("secret");
  });
});

/**
 * `form.submitted` carries VISITOR PERSONAL DATA (names, addresses, free-text
 * messages) to a third party, so it is not covered by the "subscribe to
 * everything" default that content events use. Every webhook created through
 * the admin has `events: []`, including ones wired up long before forms
 * existed — a hook relaying deploy notifications to a vendor must not silently
 * start receiving enquiries.
 */
describe("form.submitted requires an explicit subscription", () => {
  let s: Suite;

  beforeAll(async () => {
    s = await setupApi();
  });

  afterAll(async () => {
    await s.app.close();
  });

  it("does NOT deliver to a catch-all hook (events: [])", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/webhooks",
      headers: authHeaders(admin),
      payload: { name: "catch-all", url: "https://example.com/hook" },
    });
    expect(created.statusCode).toBe(200);

    const results = await dispatchWebhooks(s.app.db, {
      event: "form.submitted",
      formId: "f1",
      formName: "Contact",
      submissionId: "sub_x",
      siteId: "site_default",
      locale: "en",
      at: new Date().toISOString(),
      values: { email: "visitor@example.com" },
    });
    // Not attempted at all — no delivery row, no request, no PII in flight.
    expect(results).toHaveLength(0);
  });

  it("still delivers content events to a catch-all hook", async () => {
    const results = await dispatchWebhooks(s.app.db, {
      event: "content.published",
      siteId: "site_default",
      documentId: "d1",
      type: "ArticlePage",
      kind: "page",
      locale: "en",
      name: "Something",
      urlPath: "/something",
      at: new Date().toISOString(),
    });
    expect(results.length).toBeGreaterThan(0);
  });

  it("never delivers another SITE's event to this site's hook", async () => {
    // Every other resource that can carry content or visitor data is partitioned
    // by site. Webhooks were the exception, which stopped being cosmetic once
    // submissions rode the same pipe: brand A's hook received brand B's
    // visitors' names and messages, a read the delivery and management
    // chokepoints would both have refused.
    const results = await dispatchWebhooks(s.app.db, {
      event: "form.submitted",
      formId: "f1",
      formName: "Contact",
      submissionId: "sub_other_site",
      siteId: "site_some_other_brand",
      locale: "en",
      at: new Date().toISOString(),
      values: { email: "visitor@example.com" },
    });
    expect(results).toHaveLength(0);

    const contentElsewhere = await dispatchWebhooks(s.app.db, {
      event: "content.published",
      siteId: "site_some_other_brand",
      documentId: "d9",
      type: "ArticlePage",
      kind: "page",
      locale: "en",
      name: "Another brand's page",
      urlPath: "/x",
      at: new Date().toISOString(),
    });
    expect(contentElsewhere).toHaveLength(0);
  });

  it("delivers form.submitted to a hook that names it", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/webhooks",
      headers: authHeaders(admin),
      payload: { name: "forms", url: "https://example.com/forms", events: ["form.submitted"] },
    });
    const results = await dispatchWebhooks(s.app.db, {
      event: "form.submitted",
      formId: "f1",
      formName: "Contact",
      submissionId: "sub_y",
      siteId: "site_default",
      locale: "en",
      at: new Date().toISOString(),
    });
    expect(results).toHaveLength(1);
  });
});
