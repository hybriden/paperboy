import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Audit 2026-09-30: `merge: true` (MCP set_field / update_content's default)
 * read the merge base OUTSIDE the write transaction and wrote with no revision
 * predicate. Two overlapping merges both read the same base, both returned 200,
 * and the stored draft kept only one of the fields — the "send merge: true, it
 * merges over whatever is current" advice was false under concurrency.
 */
describe("merge:true under concurrency", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("parallel single-field merges all land (no lost update)", async () => {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(ed),
      payload: { type: "BlogPost", locale: "en", name: "Parallel Merge", data: { title: "Parallel Merge" } },
    });
    const id = created.json().documentId as string;
    const patches = [{ summary: "S" }, { author: "A" }, { body: "B" }, { publishDate: "2026-01-01T00:00:00.000Z" }];
    const results = await Promise.all(
      patches.map((data) =>
        s.app.inject({
          method: "PUT",
          url: `/api/v1/manage/content/${id}?locale=en`,
          headers: authHeaders(ed),
          payload: { data, merge: true },
        }),
      ),
    );
    for (const r of results) expect(r.statusCode).toBe(200);
    const read = (await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed) })).json();
    expect(read.data).toMatchObject({ title: "Parallel Merge", summary: "S", author: "A", body: "B", publishDate: "2026-01-01T00:00:00.000Z" });
  });
});
