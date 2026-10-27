import { describe, expect, it } from "vitest";
import { basicCredentials } from "../src/routes/oauth.js";

describe("basicCredentials (client_secret_basic)", () => {
  it("decodes the id and secret, splitting at the first colon", () => {
    const header = `Basic ${Buffer.from("mcpc_abc:se:cret%21").toString("base64")}`;
    expect(basicCredentials(header)).toEqual({ clientId: "mcpc_abc", clientSecret: "se:cret!" });
    expect(basicCredentials(undefined)).toBeNull();
    expect(basicCredentials("Bearer abc")).toBeNull();
  });

  it("runs in linear time on a header of repeated spaces (CodeQL js/polynomial-redos, alert #62)", () => {
    // `\s+(.+)$` overlapped on whitespace: a non-matching tail made it O(n²).
    const header = `Basic ${" ".repeat(50_000)}\n`;
    const start = performance.now();
    expect(basicCredentials(header)).toBeNull();
    expect(performance.now() - start).toBeLessThan(50);
  });
});
