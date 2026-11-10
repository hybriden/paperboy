import { createDb } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Publish validated the draft it read, then promoted the draft ROW by id. A
 * save that landed in between (an agent's set_field, a colleague's autosave)
 * went live without the strict publish checks or the agent-review gate: here,
 * a draft whose required title was emptied after the checks passed.
 *
 * The race is made deterministic by holding a row lock on the LIVE version,
 * which only publish touches (its demote step), so publish waits after its
 * checks while the save goes through.
 */
describe("publish promotes the draft it checked, not a later one", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  const { sql } = createDb(TEST_DB);

  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
    await sql.end();
  });

  // PGlite (#124) is one Postgres session: the staged lock holds it, so publish
  // and the save serialize and this race cannot happen there (and the test would
  // wait on itself).
  it.skipIf(process.env.TEST_PGLITE === "1")("refuses with 409 when the draft changed during publish, and the live version stays", async () => {
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(ed), payload: { type: "CardBlock", locale: "en", name: "Race card", data: { title: "Live title" } } });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().documentId as string;
    const first = await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(ed) });
    expect(first.statusCode, first.body).toBe(200);
    const edited = await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed), payload: { merge: true, data: { title: "Checked title" } } });
    expect(edited.statusCode, edited.body).toBe(200);

    const [live] = (await sql`select id from content_version where document_id = ${id} and is_current_published`) as Array<{ id: number }>;
    let publish: Awaited<ReturnType<typeof s.app.inject>> | undefined;
    await sql.begin(async (tx) => {
      await tx`select id from content_version where id = ${live!.id} for update`;
      const pending = s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(ed) }).then((r) => (publish = r));
      // Publish has passed its checks once it waits on the live row.
      for (let i = 0; i < 100; i++) {
        const [w] = (await sql`select count(*)::int as n from pg_locks where not granted`) as Array<{ n: number }>;
        if (w!.n > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const late = await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(ed), payload: { merge: true, data: { title: "" } } });
      expect(late.statusCode, late.body).toBe(200); // drafts are relaxed: an empty required title saves
      void pending;
    });
    for (let i = 0; i < 100 && !publish; i++) await new Promise((r) => setTimeout(r, 20));

    expect(publish?.statusCode, publish?.body).toBe(409);
    const delivered = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: { authorization: `Bearer ${PUBLIC_KEY}` } });
    expect(delivered.json().data.title).toBe("Live title");
  });
});
