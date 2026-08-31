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
  it("allows a public IP literal", async () => expect((await create("http://8.8.8.8/hook")).statusCode).toBe(200));

  // The ADDRESS check must catch these — not a DNS failure on the bracketed
  // hostname (`new URL("http://[::1]/").hostname` is "[::1]", which isIP rejects,
  // so every IPv6 literal used to be "rejected" only because it can't resolve).
  const PUBLIC_HOST_MSG = /public host/;
  const rejectedByAddressCheck = async (url: string) => {
    const res = await create(url);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().message, url).toMatch(PUBLIC_HOST_MSG);
  };
  it("rejects IPv6 loopback by address", () => rejectedByAddressCheck("http://[::1]/x"));
  it("rejects an IPv4-mapped loopback (::ffff:127.0.0.1)", () => rejectedByAddressCheck("http://[::ffff:127.0.0.1]/"));
  it("rejects IPv4 multicast (224/4)", () => rejectedByAddressCheck("http://224.0.0.1/"));
  it("rejects a NAT64-mapped loopback (64:ff9b::/96)", () => rejectedByAddressCheck("http://[64:ff9b::7f00:1]/"));
  it("does NOT reject a public IPv6 literal by address (2001:db8::1)", async () => {
    // Documentation range, routable as far as the address check is concerned;
    // an IP literal needs no DNS, so creation succeeds.
    expect((await create("http://[2001:db8::1]/hook")).statusCode).toBe(200);
  });
});
