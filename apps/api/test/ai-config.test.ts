import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

describe("AI provider key — in-CMS config (encrypted, write-only, Admin-only)", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("starts unconfigured (no env key in tests)", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/site/ai", headers: authHeaders(admin) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: false, source: "none", last4: null });
    const status = await s.app.inject({ method: "GET", url: "/api/v1/ai/status", headers: { cookie: admin.cookie } });
    expect(status.json().enabled).toBe(false);
  });

  it("stores a key (encrypted) and never returns it — only last4/source/model", async () => {
    const KEY = "sk-ant-test-SECRET-12349999";
    const post = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/site/ai",
      headers: authHeaders(admin),
      payload: { apiKey: KEY, model: "claude-test-model" },
    });
    expect(post.statusCode).toBe(200);
    expect(post.json()).toMatchObject({ configured: true, source: "db", last4: "9999", model: "claude-test-model" });
    expect(JSON.stringify(post.json())).not.toContain(KEY); // the key is never echoed back

    const get = await s.app.inject({ method: "GET", url: "/api/v1/manage/site/ai", headers: authHeaders(admin) });
    expect(JSON.stringify(get.json())).not.toContain(KEY);
    expect(get.json().last4).toBe("9999");

    // The assistant now reports enabled (DB key overrides the absent env key).
    const status = await s.app.inject({ method: "GET", url: "/api/v1/ai/status", headers: { cookie: admin.cookie } });
    expect(status.json().enabled).toBe(true);
  });

  it("clears the key (falls back to env — none in tests)", async () => {
    const post = await s.app.inject({ method: "POST", url: "/api/v1/manage/site/ai", headers: authHeaders(admin), payload: { apiKey: null } });
    expect(post.json()).toMatchObject({ configured: false, source: "none", last4: null });
    const status = await s.app.inject({ method: "GET", url: "/api/v1/ai/status", headers: { cookie: admin.cookie } });
    expect(status.json().enabled).toBe(false);
  });

  it("is Admin-only (Editor is denied read + write)", async () => {
    const ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    const get = await s.app.inject({ method: "GET", url: "/api/v1/manage/site/ai", headers: { cookie: ed.cookie } });
    expect(get.statusCode).toBe(403);
    const post = await s.app.inject({ method: "POST", url: "/api/v1/manage/site/ai", headers: authHeaders(ed), payload: { apiKey: "sk-ant-x" } });
    expect(post.statusCode).toBe(403);
  });

  it("openai unit: provider + key + baseUrl + model round-trip; baseUrl is validated and normalized", async () => {
    const bad = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/site/ai",
      headers: authHeaders(admin),
      payload: { provider: "openai", baseUrl: "ftp://nope" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain("http");

    const post = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/site/ai",
      headers: authHeaders(admin),
      payload: { provider: "openai", apiKey: "sk-oai-secret-4321", baseUrl: "https://llm.example/v1/", model: "gpt-test" },
    });
    expect(post.statusCode).toBe(200);
    expect(post.json()).toMatchObject({
      configured: true,
      source: "db",
      provider: "openai",
      last4: "4321",
      model: "gpt-test",
      baseUrl: "https://llm.example/v1", // trailing slash normalized away
    });
    expect(JSON.stringify(post.json())).not.toContain("sk-oai-secret");
  });

  it("a stored key is BOUND to its provider: switching provider clears it (never reused cross-vendor)", async () => {
    const post = await s.app.inject({ method: "POST", url: "/api/v1/manage/site/ai", headers: authHeaders(admin), payload: { provider: "anthropic" } });
    expect(post.statusCode).toBe(200);
    // The openai key must NOT survive under the anthropic provider.
    expect(post.json()).toMatchObject({ configured: false, source: "none", provider: "anthropic", last4: null });
  });

  it("env keys are vendor-bound too: an env Anthropic key never serves the openai provider (key-exfil pin)", async () => {
    s.app.aiEnv.ANTHROPIC_API_KEY = "sk-ant-env-9876";
    try {
      // Under the anthropic provider the env key applies…
      const asAnthropic = await s.app.inject({ method: "GET", url: "/api/v1/manage/site/ai", headers: authHeaders(admin) });
      expect(asAnthropic.json()).toMatchObject({ configured: true, source: "env", provider: "anthropic", last4: "9876" });

      // …but flipping the provider to openai with an attacker-controlled baseUrl
      // must NOT hand that key to the new endpoint: the unit rule reports
      // unconfigured instead of borrowing the Anthropic env key.
      const flip = await s.app.inject({
        method: "POST",
        url: "/api/v1/manage/site/ai",
        headers: authHeaders(admin),
        payload: { provider: "openai", baseUrl: "https://evil.example/v1" },
      });
      expect(flip.json()).toMatchObject({ configured: false, source: "none", provider: "openai" });
      const status = await s.app.inject({ method: "GET", url: "/api/v1/ai/status", headers: { cookie: admin.cookie } });
      expect(status.json().enabled).toBe(false);
    } finally {
      s.app.aiEnv.ANTHROPIC_API_KEY = undefined;
      await s.app.inject({ method: "POST", url: "/api/v1/manage/site/ai", headers: authHeaders(admin), payload: { provider: "anthropic", baseUrl: null } });
    }
  });

  it("POST /site/ai/test does a REAL model roundtrip and reports the endpoint's own error on misconfig", async () => {
    // Unconfigured → honest failure, no model call.
    const cold = await s.app.inject({ method: "POST", url: "/api/v1/manage/site/ai/test", headers: authHeaders(admin), payload: {} });
    expect(cold.json()).toMatchObject({ ok: false });
    expect(cold.json().message).toContain("No API key");

    await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/site/ai",
      headers: authHeaders(admin),
      payload: { provider: "openai", apiKey: "sk-oai-test-1", baseUrl: "https://llm.test/v1", model: "gpt-test" },
    });
    try {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: "pong" } }] }) });
      vi.stubGlobal("fetch", fetchMock);
      const ok = await s.app.inject({ method: "POST", url: "/api/v1/manage/site/ai/test", headers: authHeaders(admin), payload: {} });
      expect(ok.json()).toMatchObject({ ok: true, provider: "openai", model: "gpt-test" });
      expect(fetchMock.mock.calls[0]![0]).toBe("https://llm.test/v1/chat/completions");
      expect((fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers.authorization).toBe("Bearer sk-oai-test-1");

      // A wrong model/baseUrl surfaces the provider's message — key presence alone can't catch this.
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => 'model "gpt-test" not found' }));
      const bad = await s.app.inject({ method: "POST", url: "/api/v1/manage/site/ai/test", headers: authHeaders(admin), payload: {} });
      expect(bad.json().ok).toBe(false);
      expect(bad.json().message).toContain("not found");
    } finally {
      vi.unstubAllGlobals();
      await s.app.inject({ method: "POST", url: "/api/v1/manage/site/ai", headers: authHeaders(admin), payload: { provider: "anthropic", apiKey: null, model: null, baseUrl: null } });
    }
  });

  it("GET /site/ai/models probes the endpoint's catalog through the saved config (searchable model picker)", async () => {
    // Unconfigured → honest, self-teaching failure (no probe attempted).
    const cold = await s.app.inject({ method: "GET", url: "/api/v1/manage/site/ai/models", headers: authHeaders(admin) });
    expect(cold.json()).toMatchObject({ ok: false, models: [] });
    expect(cold.json().message).toContain("No API key");

    await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/site/ai",
      headers: authHeaders(admin),
      payload: { provider: "openai", apiKey: "sk-oai-models", baseUrl: "https://router.test/v1", model: "gpt-test" },
    });
    try {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "meta/llama-3" }, { id: "anthropic/claude-x" }] }),
      });
      vi.stubGlobal("fetch", fetchMock);
      const ok = await s.app.inject({ method: "GET", url: "/api/v1/manage/site/ai/models", headers: authHeaders(admin) });
      expect(ok.json()).toMatchObject({ ok: true, provider: "openai", models: ["anthropic/claude-x", "meta/llama-3"] });
      expect(fetchMock.mock.calls[0]![0]).toBe("https://router.test/v1/models");

      // A proxy without /models is reported honestly, steering to manual entry.
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "not found" }));
      const noRoute = await s.app.inject({ method: "GET", url: "/api/v1/manage/site/ai/models", headers: authHeaders(admin) });
      expect(noRoute.json().ok).toBe(false);
      expect(noRoute.json().message).toContain("manually");

      // Admin-only, like every AI-config surface.
      const ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
      const denied = await s.app.inject({ method: "GET", url: "/api/v1/manage/site/ai/models", headers: { cookie: ed.cookie } });
      expect(denied.statusCode).toBe(403);
    } finally {
      vi.unstubAllGlobals();
      await s.app.inject({ method: "POST", url: "/api/v1/manage/site/ai", headers: authHeaders(admin), payload: { provider: "anthropic", apiKey: null, model: null, baseUrl: null } });
    }
  });
});
