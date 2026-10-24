import { copyVariant, createDb, getAccessContext } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

/**
 * #79: a top-level key the type doesn't declare (`titel` for `heading`) used to
 * persist with 200 and never be delivered — garbage-in-success-out (rule #1).
 * Only keys the CALLER introduces are refused: a stray key already stored (a
 * removed field, an old row) rides along so it never bricks unrelated edits.
 */
describe("unknown top-level data keys", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  let pageId: string;
  const raw = createDb(TEST_DB, { max: 1 }).sql;
  const put = (payload: Record<string, unknown>) =>
    s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${pageId}?locale=en`, headers: authHeaders(ed), payload });

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "LandingPage", locale: "en", name: "Unknown Keys" },
    });
    pageId = created.json().documentId;
  });
  afterAll(async () => {
    await raw.end();
    await s.app.close();
  });

  it("a merge with a misspelled key is a 422 naming the key and the closest field", async () => {
    const res = await put({ merge: true, data: { headng: "x" } });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toMatch(/headng.*not a field of LandingPage.*did you mean 'heading'/);
    const got = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${pageId}?locale=en`, headers: authHeaders(ed) });
    expect(got.json().data).not.toHaveProperty("headng");
  });

  it("create refuses an unknown key too", async () => {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "LandingPage", locale: "en", name: "Bad Create", data: { zzz: 1 } },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toMatch(/zzz.*not a field of LandingPage.*Fields: .*heading/);
  });

  it("a stray key already stored doesn't block other edits, in merge or full replace", async () => {
    await raw`update content_version set data = data || '{"legacy":"old"}'::jsonb where document_id = ${pageId} and locale = 'en'`;
    const merged = await put({ merge: true, data: { heading: "Merged" } });
    expect(merged.statusCode, merged.body).toBe(200);
    const full = await put({ data: { ...merged.json().data, heading: "Full" } });
    expect(full.statusCode, full.body).toBe(200);
    expect(full.json().data.legacy).toBe("old");
    // copy_variant (MCP) carries only declared fields, so the stray key can't fail the copy.
    const [editor] = await raw`select id from users where email = 'editor@paperboy.test'`;
    const copied = await copyVariant(s.app.db, await getAccessContext(s.app.db, editor!.id as string), pageId, "en", "nb");
    expect(copied.data).toEqual({ heading: "Full" });
  });
});
