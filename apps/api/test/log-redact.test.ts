import { describe, expect, it } from "vitest";
import { redactForLog } from "@paperboy/shared";

// S3-H1: the MCP tool wrapper logs the full tool args to stdout/docker logs on
// failure (rule #6 trail). create_user takes a cleartext `password`, and a common
// duplicate-email failure logs it verbatim. redactForLog masks secret-bearing keys
// while keeping the rest for diagnosability.
describe("redactForLog (MCP arg logging must not leak secrets)", () => {
  it("masks the password but keeps other args for diagnosability", () => {
    const out = redactForLog({ email: "a@b.c", name: "Ada", password: "S3cret-Passw0rd", roles: ["admin"] });
    const s = JSON.stringify(out);
    expect(s).not.toContain("S3cret-Passw0rd");
    expect(s).toContain("a@b.c");
    expect((out as Record<string, unknown>).password).toBe("[redacted]");
  });

  it("masks common secret key variants", () => {
    const out = redactForLog({ newPassword: "x", token: "t", secret: "s", apiKey: "k", code: "123456" }) as Record<string, unknown>;
    for (const k of ["newPassword", "token", "secret", "apiKey", "code"]) expect(out[k]).toBe("[redacted]");
  });

  it("passes through non-objects unchanged", () => {
    expect(redactForLog("hi")).toBe("hi");
    expect(redactForLog(undefined)).toBe(undefined);
    expect(redactForLog(null)).toBe(null);
  });
});
