import {
  type AccessContext,
  adminUpdateUser,
  createContent,
  createDb,
  createSite,
  createUser,
  getAccessContext,
} from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, setupApi } from "./helpers.js";

/**
 * S2-H1: section scopes are per-site (user_scope.site_id). The write paths
 * (createUser / adminUpdateUser) must store each scope under the SECTION'S OWN
 * site, not the NOT-NULL DEFAULT 'site_default'. Otherwise an Author scoped to a
 * section in a non-default site reads back EMPTY sections (getAccessContext filters
 * by the active site) and deny-by-default hides all their content. Red-first:
 * before the fix the scope lands on site_default and the non-default assertions fail.
 */
describe("multisite — Author section scopes land on the section's own site (S2-H1)", () => {
  let s: Suite;
  const raw = createDb(TEST_DB);
  let ctxA: AccessContext; // admin, Default site
  let siteBId: string;
  let sectionInB: string;
  let sectionInDefault: string;

  beforeAll(async () => {
    s = await setupApi();
    const rows = (await raw.sql`SELECT id FROM users WHERE email='admin@paperboy.test' LIMIT 1`) as Array<{ id: string }>;
    const adminId = rows[0]!.id;
    ctxA = await getAccessContext(s.app.db, adminId);
    const siteB = await createSite(s.app.db, ctxA, { slug: "scope-brand-b", name: "Scope Brand B", defaultLocale: "en" });
    siteBId = siteB.id;
    const ctxB = await getAccessContext(s.app.db, adminId, siteBId);
    sectionInB = (await createContent(s.app.db, ctxB, { type: "LandingPage", locale: "en", name: "B Section", parentId: null })).documentId;
    sectionInDefault = (await createContent(s.app.db, ctxA, { type: "LandingPage", locale: "en", name: "Default Section", parentId: null })).documentId;
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  it("createUser: an Author scoped to a non-default-site section sees it under that site", async () => {
    const authorId = await createUser(s.app.db, {
      email: "author-b@paperboy.test",
      name: "Author B",
      password: "Author!Passw0rd",
      roles: ["Author"],
      sections: [sectionInB],
    });
    const ctx = await getAccessContext(s.app.db, authorId, siteBId);
    expect(ctx.sections).toContain(sectionInB);
  });

  it("createUser: a Default-site section assignment still works (regression)", async () => {
    const authorId = await createUser(s.app.db, {
      email: "author-def@paperboy.test",
      name: "Author Def",
      password: "Author!Passw0rd",
      roles: ["Author"],
      sections: [sectionInDefault],
    });
    const ctx = await getAccessContext(s.app.db, authorId); // Default site
    expect(ctx.sections).toContain(sectionInDefault);
  });

  it("adminUpdateUser: reassigning sections also lands on the section's site", async () => {
    const authorId = await createUser(s.app.db, {
      email: "author-upd@paperboy.test",
      name: "Author Upd",
      password: "Author!Passw0rd",
      roles: ["Author"],
      sections: [],
    });
    await adminUpdateUser(s.app.db, ctxA, authorId, { sections: [sectionInB] });
    const ctx = await getAccessContext(s.app.db, authorId, siteBId);
    expect(ctx.sections).toContain(sectionInB);
  });
});
