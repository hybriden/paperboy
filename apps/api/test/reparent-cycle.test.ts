import { type AccessContext, createContent, createDb, getAccessContext, moveContent } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, setupApi } from "./helpers.js";

/**
 * S2-M10: the reparent acyclicity walk ran OUTSIDE the mutating transaction with no
 * lock, so two opposing concurrent reparents ("move X under Y" + "move Y under X")
 * could both pass the check and commit a parent cycle. The check now runs inside the
 * tx under a per-site advisory lock, so exactly one wins and no cycle forms.
 */
describe("moveContent — concurrent opposing reparents cannot form a cycle", () => {
  let s: Suite;
  const raw = createDb(TEST_DB);
  let ctx: AccessContext;

  beforeAll(async () => {
    s = await setupApi();
    const rows = (await raw.sql`SELECT id FROM users WHERE email='admin@paperboy.test' LIMIT 1`) as Array<{ id: string }>;
    ctx = await getAccessContext(s.app.db, rows[0]!.id);
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  it("two opposing reparents settle with no parent cycle (exactly one wins)", async () => {
    const x = (await createContent(s.app.db, ctx, { type: "LandingPage", locale: "en", name: "X root", parentId: null })).documentId;
    const y = (await createContent(s.app.db, ctx, { type: "LandingPage", locale: "en", name: "Y root", parentId: null })).documentId;

    const results = await Promise.allSettled([
      moveContent(s.app.db, ctx, x, { parentId: y }),
      moveContent(s.app.db, ctx, y, { parentId: x }),
    ]);

    const parents = (await raw.sql`SELECT document_id, parent_id FROM content_item WHERE document_id IN (${x}, ${y})`) as Array<{ document_id: string; parent_id: string | null }>;
    const px = parents.find((p) => p.document_id === x)?.parent_id ?? null;
    const py = parents.find((p) => p.document_id === y)?.parent_id ?? null;

    expect(px === y && py === x).toBe(false); // no 2-node cycle
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1); // one move rejected
  });
});
