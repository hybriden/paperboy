import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, setupApi } from "./helpers.js";

/**
 * A frontend calls the CMS from its own server, so every visitor arrives from
 * one address. Per-IP limits then counted the whole site: 10 form posts a
 * minute shared by every visitor (one bot blocked every real enquiry), and
 * 600 page reads a minute per route.
 */
describe("rate limits behind a server-side frontend", () => {
  let s: Suite;
  // The frontend sits on the private network, and TRUST_PROXY trusts it.
  const FRONTEND = "10.0.0.5";

  beforeAll(async () => {
    s = await setupApi({ TRUST_PROXY: "10.0.0.0/8" });
  });
  afterAll(async () => {
    await s.app.close();
  });

  const post = (remoteAddress: string, forwardedFor: string, i: number) =>
    s.app.inject({
      method: "POST",
      url: `/api/v1/delivery/forms/form-${i}/submissions`,
      headers: { authorization: `Bearer ${PUBLIC_KEY}`, "x-forwarded-for": forwardedFor },
      remoteAddress,
      payload: { values: {}, honeypot: "bot" }, // dropped as spam: 202, no form needed
    });

  it("counts each visitor the trusted frontend forwards on its own", async () => {
    const before = s.app.formConfig.submitRateMax;
    s.app.formConfig.submitRateMax = 3;
    try {
      const visitors: number[] = [];
      for (let i = 0; i < 6; i++) visitors.push((await post(FRONTEND, `203.0.113.${10 + i}`, i)).statusCode);
      expect(visitors).not.toContain(429);

      const oneVisitor: number[] = [];
      for (let i = 0; i < 6; i++) oneVisitor.push((await post(FRONTEND, "203.0.113.99", i)).statusCode);
      expect(oneVisitor).toContain(429);

      // An untrusted caller can't pick its own address per request.
      const spoofer: number[] = [];
      for (let i = 0; i < 6; i++) spoofer.push((await post("198.51.100.9", `203.0.113.${40 + i}`, i)).statusCode);
      expect(spoofer).toContain(429);
    } finally {
      s.app.formConfig.submitRateMax = before;
    }
  });
});

describe("DELIVERY_RATE_MAX sets the delivery read limit", () => {
  const reads = async (s: Suite, n: number) => {
    const codes = new Set<number>();
    for (let i = 0; i < n; i++) {
      const res = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content?type=ArticlePage&limit=1&i=${i}`, headers: { authorization: `Bearer ${PUBLIC_KEY}` } });
      codes.add(res.statusCode);
    }
    return codes;
  };

  it("a low setting limits sooner", async () => {
    const s = await setupApi({ DELIVERY_RATE_MAX: "20" });
    try {
      expect(await reads(s, 25)).toContain(429);
    } finally {
      await s.app.close();
    }
  });

  it("the default is well above one frontend's 600 a minute", async () => {
    const s = await setupApi();
    try {
      expect(await reads(s, 700)).not.toContain(429);
    } finally {
      await s.app.close();
    }
  });
});
