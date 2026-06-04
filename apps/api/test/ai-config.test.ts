import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
});
