import { createDb, pgErrorCode } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DB, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Every "does it already exist?" pre-check in the query layer races: two
 * concurrent creates both pass it, one insert then loses on the unique index and
 * surfaced as an opaque 500. The SQLSTATE walker used to live privately in
 * content.ts for two call sites; the API's error handler is the safety net that
 * turns ANY 23505/23503/22P02 that escapes into the right 4xx.
 */
describe("pgErrorCode walks the DrizzleQueryError cause chain", () => {
  it("finds the SQLSTATE on the error itself or on a nested cause; null otherwise", () => {
    expect(pgErrorCode({ code: "23505" })).toBe("23505");
    expect(pgErrorCode(new Error("wrapped", { cause: new Error("deeper", { cause: { code: "23503" } }) }))).toBe("23503");
    expect(pgErrorCode(new Error("plain"))).toBeNull();
    expect(pgErrorCode(null)).toBeNull();
    expect(pgErrorCode("string")).toBeNull();
  });
});

describe("a losing concurrent duplicate is a 409, not a 500", () => {
  let s: Suite;
  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await s.app.close();
  });

  // The race is STAGED so it is deterministic: an uncommitted insert of the same
  // name is invisible to the route's pre-check select, and the route's own insert
  // then blocks on the unique index until that transaction commits — at which
  // point it loses with a genuine 23505 that only the error handler can catch.
  it("a create that loses on the unique index after passing the pre-check is a 409 conflict", async () => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const def = { name: "RaceType", displayName: "Race type", kind: "block", fields: [{ name: "title", displayName: "Title", type: "text" }] };
    const raw = createDb(TEST_DB);
    try {
      let viaApi: Promise<{ statusCode: number; body: string; json: () => { error: string; message: string } }> | undefined;
      await raw.sql.begin(async (tx) => {
        await tx`insert into content_type (name, display_name, kind, definition) values ('RaceType', 'Race type', 'block', '{}'::jsonb)`;
        viaApi = s.app.inject({ method: "POST", url: "/api/v1/manage/content-types", headers: authHeaders(admin), payload: def });
        await new Promise((r) => setTimeout(r, 750)); // the API's insert is now waiting on this row's lock
      });
      const res = await viaApi!;
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toBe("conflict");
      // The safety-net wording, not the pre-check's — proof the 23505 reached the handler.
      expect(res.json().message).toContain("same unique value already exists");
    } finally {
      await raw.sql`delete from content_type where name = 'RaceType'`;
      await raw.sql.end();
    }
  });
});
