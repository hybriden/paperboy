import { type AccessContext, createContent, getAccessContext } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOLS } from "../src/agent.js";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * M6: the in-product "Build from brief" agent's update_content tool omitted
 * `merge`, so updateContent took the REPLACE branch and each call wiped fields
 * set by prior calls — the exact footgun agent-API rule #5 (merge-by-default for
 * agent surfaces) exists to prevent. Two sequential edits must accumulate.
 */
describe("in-product agent update_content merges by default (M6)", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let ctx: AccessContext;
  let docId: string;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const users = (await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: { cookie: admin.cookie } })).json() as Array<{ id: string; email: string }>;
    const adminId = users.find((u) => u.email === "admin@paperboy.test")!.id;
    ctx = await getAccessContext(s.app.db, adminId);
    docId = (await createContent(s.app.db, ctx, { type: "ArticlePage", locale: "en", name: "Brief", parentId: null })).documentId;
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("a second update_content keeps fields the first one set", async () => {
    const update = TOOLS.find((t) => t.name === "update_content")!;
    const deps = { db: s.app.db, ctx, cfg: { model: "none" }, emit: () => undefined };
    await update.run({ documentId: docId, locale: "en", data: { heading: "Kept" } }, deps);
    await update.run({ documentId: docId, locale: "en", data: { seoNotes: "Added" } }, deps);

    const working = (await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${docId}?locale=en`, headers: { cookie: admin.cookie } })).json();
    expect(working.data.seoNotes).toBe("Added");
    expect(working.data.heading).toBe("Kept"); // would be dropped under replace semantics
  });
});
