import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * AI route honesty contract: with no provider key configured, model-requiring
 * tasks answer 409 with a self-teaching message (never the input dressed up as
 * a 200 "result"), while the deterministic truncation tasks still serve a
 * clearly-labeled fallback. /ai/alt-text is vision-only — no filename
 * heuristics — so it is 409 without a key too.
 */
describe("AI routes — no provider key", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    // Make the no-key state deterministic even if the host shell has a key.
    delete process.env.ANTHROPIC_API_KEY;
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("/ai/status reports disabled", async () => {
    const r = await s.app.inject({ method: "GET", url: "/api/v1/ai/status", headers: authHeaders(ed) });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().enabled).toBe(false);
  });

  it("/ai/assist: truncation tasks still work, labeled as fallback", async () => {
    const r = await s.app.inject({
      method: "POST",
      url: "/api/v1/ai/assist",
      headers: authHeaders(ed),
      payload: { task: "meta_title", input: "A long headline about something. And more." },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ result: "A long headline about something", provider: "fallback" });
  });

  for (const task of ["improve", "rewrite", "translate", "variants", "alt_text", "write", "schema_fields"]) {
    it(`/ai/assist: '${task}' answers 409 with a self-teaching message`, async () => {
      const r = await s.app.inject({
        method: "POST",
        url: "/api/v1/ai/assist",
        headers: authHeaders(ed),
        payload: { task, input: "some text", targetLocale: "nb" },
      });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().message).toContain("Settings → AI");
    });
  }

  it("/ai/alt-text requires a key (409), auth (401), and an existing asset", async () => {
    const noAuth = await s.app.inject({ method: "POST", url: "/api/v1/ai/alt-text", payload: { documentId: "x" } });
    expect(noAuth.statusCode).toBe(401);

    const r = await s.app.inject({
      method: "POST",
      url: "/api/v1/ai/alt-text",
      headers: authHeaders(ed),
      payload: { documentId: "does-not-exist" },
    });
    // No key configured → the route refuses before touching the asset.
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().message).toContain("Settings → AI");
  });

  it("/ai/translate keeps copy-source seed semantics (workflow-level honesty)", async () => {
    const r = await s.app.inject({
      method: "POST",
      url: "/api/v1/ai/translate",
      headers: authHeaders(ed),
      payload: { texts: ["Hello", "World"], targetLocale: "nb" },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ results: ["Hello", "World"], provider: "fallback" });
  });
});
