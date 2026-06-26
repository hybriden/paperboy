import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * H3: createWebhook validated only the URL scheme, so a webhook.manage holder
 * could point the server's signed POSTs at loopback, the cloud metadata endpoint
 * (169.254.169.254), or RFC1918 hosts — SSRF. The egress guard denies internal
 * targets by default (an explicit PAPERBOY_WEBHOOK_ALLOW_PRIVATE escape hatch
 * exists for internal deployments and is exercised by the main webhook suite).
 */
const savedFlag = process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE;

describe("Webhook SSRF egress guard", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    delete process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE; // deny by default
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
    if (savedFlag === undefined) delete process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE;
    else process.env.PAPERBOY_WEBHOOK_ALLOW_PRIVATE = savedFlag;
  });

  const create = (url: string) =>
    s.app.inject({ method: "POST", url: "/api/v1/manage/webhooks", headers: authHeaders(admin), payload: { name: "x", url } });

  it("rejects a loopback target", async () => expect((await create("http://127.0.0.1/hook")).statusCode).toBe(400));
  it("rejects the cloud metadata endpoint", async () => expect((await create("http://169.254.169.254/latest/meta-data/")).statusCode).toBe(400));
  it("rejects an RFC1918 target", async () => expect((await create("http://10.0.0.5/x")).statusCode).toBe(400));
  it("rejects IPv6 loopback", async () => expect((await create("http://[::1]/x")).statusCode).toBe(400));
  it("allows a public IP literal", async () => expect((await create("http://8.8.8.8/hook")).statusCode).toBe(200));
});
