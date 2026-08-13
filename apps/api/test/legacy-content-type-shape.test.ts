import { schemaTables } from "@paperboy/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Stored content-type definitions age: rows written before a field was added to
 * FieldDef (e.g. `optionsFromContentTypes`, added with a .default()) simply lack
 * that key. Zod-3-era serialization backfilled defaults at the response
 * serializer, so nobody noticed; fastify-type-provider-zod v7 + Zod 4 validate
 * the response as-is and turned every such row into an opaque 500
 * ("ResponseSerializationError") — hit live on cms.neoteric.no 2026-08-13 on
 * GET /manage/content-types. The seed always writes current-shape definitions,
 * which is exactly why the suite never caught it.
 *
 * Reads must therefore normalize STORED definitions through the current schema
 * (defaults filled) at the read chokepoints — never trust a stored row to be
 * current-shape.
 */
describe("legacy-shaped stored content types still serve", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");

    // Age EVERY stored definition to a pre-`optionsFromContentTypes` shape:
    // strip the newer defaulted keys exactly as an old row lacks them.
    const rows = await s.app.db.select().from(schemaTables.contentType);
    for (const row of rows) {
      const def = row.definition as { fields: Record<string, unknown>[] };
      for (const f of def.fields) {
        delete f.optionsFromContentTypes;
        delete f.multiple;
        delete f.group;
      }
      await s.app.db
        .update(schemaTables.contentType)
        .set({ definition: def })
        .where(eq(schemaTables.contentType.name, row.name));
    }
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("GET /manage/content-types returns 200 with defaults filled, not a 500", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/content-types", headers: authHeaders(admin) });
    expect(res.statusCode).toBe(200);
    const types = res.json() as { name: string; fields: Record<string, unknown>[] }[];
    expect(types.length).toBeGreaterThan(0);
    for (const t of types) {
      for (const f of t.fields) {
        expect(f.optionsFromContentTypes).toBeTypeOf("boolean");
        expect(f.group).toBeTypeOf("string");
      }
    }
  });

  it("delivery still serves items of a legacy-shaped type", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en&populate=2`,
      headers: { "x-api-key": PUBLIC_KEY },
    });
    expect(res.statusCode).toBe(200);
  });
});
