import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * S2-L5: editing a published item seeds a NEW draft (SELECT-then-INSERT). Under
 * concurrency the partial unique index content_version_one_draft correctly rejects
 * the duplicate (no corruption), but the 23505 surfaced as an opaque HTTP 500
 * instead of a self-teaching 409 — the worst error for an agent mid-loop. The
 * losing writer must get a 409 conflict, never a 500.
 */
describe("updateContent — concurrent draft-seed yields 409, never an opaque 500", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("concurrent edits of a freshly-published item never return 500", async () => {
    // Create + publish so the item has NO working draft — the next edits race to seed one.
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "ArticlePage", locale: "en", name: "Seed Race" } });
    const id = created.json().documentId as string;
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin), payload: { data: { heading: "Base" } } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(admin) });

    const edits = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin), payload: { data: { heading: `Edit ${i}` } } }),
      ),
    );
    const codes = edits.map((e) => e.statusCode);
    expect(codes).not.toContain(500); // a concurrent seed conflict must be a clean 409, not a 500
    expect(codes.every((c) => c === 200 || c === 409)).toBe(true);
  });
});
