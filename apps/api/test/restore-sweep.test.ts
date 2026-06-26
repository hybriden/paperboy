import { type AccessContext, createContent, getAccessContext, listTrash, restoreContent, softDelete } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, login, setupApi } from "./helpers.js";

/**
 * S2-M8: softDelete excludes already-trashed descendants (they keep their own
 * earlier deletedAt), but restoreContent walked children unconditionally and
 * cleared deletedAt on the whole subtree — so restoring a parent resurrected a
 * child that had been trashed in a SEPARATE, earlier sweep. Restore must be scoped
 * to descendants sharing the parent's sweep timestamp.
 */
describe("restoreContent only restores the parent's own trash sweep", () => {
  let s: Suite;
  let ctx: AccessContext;

  beforeAll(async () => {
    s = await setupApi();
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const users = (await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: { cookie: admin.cookie } })).json() as Array<{ id: string; email: string }>;
    ctx = await getAccessContext(s.app.db, users.find((u) => u.email === "admin@paperboy.test")!.id);
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("a child trashed in an earlier sweep stays trashed when the parent is restored", async () => {
    const parent = (await createContent(s.app.db, ctx, { type: "ArticlePage", locale: "en", name: "Trash Parent", parentId: null })).documentId;
    const child = (await createContent(s.app.db, ctx, { type: "ArticlePage", locale: "en", name: "Trash Child", parentId: parent })).documentId;

    await softDelete(s.app.db, ctx, child); // sweep 1: just the child
    await new Promise((r) => setTimeout(r, 10)); // guarantee a distinct sweep timestamp
    await softDelete(s.app.db, ctx, parent); // sweep 2: just the parent (child already trashed → excluded)

    await restoreContent(s.app.db, ctx, parent);

    const trashed = (await listTrash(s.app.db, ctx)).map((t) => t.documentId);
    expect(trashed).toContain(child); // earlier-sweep child must remain trashed
    expect(trashed).not.toContain(parent); // parent restored
  });
});
