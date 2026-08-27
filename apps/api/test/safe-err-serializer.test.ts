import { safeErrSerializer } from "../src/logging.js";
import { describe, expect, it } from "vitest";

/**
 * The error serializer must never let bound query params (which include the
 * opaque session token, bound by readSession on every request) reach the log —
 * a DrizzleQueryError bakes them into `err.message` after "\nparams:".
 */
describe("safeErrSerializer", () => {
  it("redacts the params tail of a DrizzleQueryError message, keeping the SQL", () => {
    const err = Object.assign(new Error('Failed query: select * from "session" where "id" = $1\nparams: sess_SECRETTOKEN123'), {
      name: "DrizzleQueryError",
    });
    const out = safeErrSerializer(err);
    expect(out.message).not.toContain("sess_SECRETTOKEN123");
    expect(out.message).toContain("params: [redacted]");
    expect(out.message).toContain('select * from "session"'); // the placeholder SQL is kept
    expect(out.type).toBe("DrizzleQueryError");
  });

  it("redacts params in the error's cause too", () => {
    const cause = new Error("Failed query: update users set totp_secret = $1\nparams: v2:totp:LEAKED");
    const err = Object.assign(new Error("wrapped"), { name: "DrizzleQueryError", cause });
    const out = safeErrSerializer(err);
    expect(out.cause?.message).not.toContain("LEAKED");
    expect(out.cause?.message).toContain("[redacted]");
  });

  it("leaves an ordinary error untouched", () => {
    const out = safeErrSerializer(new Error("something broke"));
    expect(out.message).toBe("something broke");
    expect(out.type).toBe("Error");
  });
});
