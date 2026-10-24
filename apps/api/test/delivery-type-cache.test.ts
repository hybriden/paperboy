import { createDb } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, TEST_DB, setupApi } from "./helpers.js";

/**
 * Delivery keeps the parsed content types between requests and asks the
 * database only which rows changed (xmin). A type written by ANOTHER process
 * (the MCP server has its own connection pool) must be seen by the very next
 * request: a field made private there must stop being delivered here, or the
 * cache would leak it.
 */
describe("delivery's content type cache sees a write from another connection on the next request", () => {
  let s: Suite;
  const other = createDb(TEST_DB, { max: 1 }).sql;
  const siteSettings = async () => {
    const res = await s.app.inject({ url: "/api/v1/delivery/globals/SiteSettings?locale=en", headers: { authorization: `Bearer ${PUBLIC_KEY}` } });
    expect(res.statusCode).toBe(200);
    return res.json() as { data: Record<string, unknown>; fieldTypes: Record<string, string> };
  };

  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await other.end();
    await s.app.close();
  });

  it("a field made private elsewhere is gone from the next response", async () => {
    const before = await siteSettings();
    expect(before.fieldTypes).toHaveProperty("siteName");

    const [row] = await other`select definition from content_type where name = 'SiteSettings'`;
    const def = row!.definition as { fields: Array<{ name: string; delivery?: string }> };
    for (const f of def.fields) if (f.name === "siteName") f.delivery = "private";
    await other`update content_type set definition = ${JSON.stringify(def)}::jsonb where name = 'SiteSettings'`;

    const after = await siteSettings();
    expect(after.fieldTypes).not.toHaveProperty("siteName");
    expect(after.data).not.toHaveProperty("siteName");
  });
});
