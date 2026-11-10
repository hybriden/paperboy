import { afterEach, describe, expect, it, vi } from "vitest";

const { submitForm, requestHeaders } = vi.hoisted(() => ({ submitForm: vi.fn(), requestHeaders: { current: new Headers() } }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders.current }));
vi.mock("../lib/delivery", () => ({ submitForm }));

import { submitFormAction } from "./submit-form";

const input = { formId: "f1", values: {}, elapsedMs: 5000, honeypot: "", idempotencyKey: "k1" };

/**
 * The action posts from this server, so without the visitor's address every
 * visitor shared one per-IP submit limit on the CMS. The address comes ONLY
 * from the header the operator names: Next keeps a visitor's own
 * X-Forwarded-For, so trusting it by default would let a bot pick a fresh
 * address per request.
 */
describe("submitFormAction forwards the visitor's address", () => {
  afterEach(() => {
    delete process.env.PAPERBOY_CLIENT_IP_HEADER;
    submitForm.mockReset();
  });

  it("from the header the operator's edge sets", async () => {
    process.env.PAPERBOY_CLIENT_IP_HEADER = "cf-connecting-ip";
    requestHeaders.current = new Headers({ "cf-connecting-ip": "203.0.113.5", "x-forwarded-for": "198.51.100.1" });
    submitForm.mockResolvedValueOnce({ ok: true, submissionId: "s", confirmation: { type: "message" } });
    await submitFormAction(input);
    expect(submitForm).toHaveBeenCalledWith(expect.objectContaining({ visitorIp: "203.0.113.5" }));
  });

  it("not at all when no header is configured, whatever the visitor sent", async () => {
    requestHeaders.current = new Headers({ "x-forwarded-for": "198.51.100.1" });
    submitForm.mockResolvedValueOnce({ ok: true, submissionId: "s", confirmation: { type: "message" } });
    await submitFormAction(input);
    expect(submitForm.mock.calls[0]![0].visitorIp).toBeUndefined();
  });
});
