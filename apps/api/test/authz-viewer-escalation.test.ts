import {
  type AccessContext,
  createContent,
  createDb,
  createUser,
  getAccessContext,
  getContent,
  listPages,
  updateContent,
} from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, setupApi } from "./helpers.js";

/**
 * Adding the read-only Viewer role on top of a section-scoped Author must NOT
 * turn scoped write access into site-wide write access.
 *
 * `siteWide` used to be `roles.some(Admin | Editor | Viewer)`, and permissions
 * are the union over roles, so `[Author, Viewer]` yielded content.create/update
 * AND siteWide — and every scope gate is `siteWide || sections.includes(...)`,
 * with no read/write distinction. An Admin toggling "Viewer" on top of "Author"
 * (a natural "author in their section, may review the whole site" choice)
 * silently handed that account write over every document in the site.
 *
 * The fix splits the flag: write scoping uses `siteWide` (Admin | Editor);
 * read scoping uses `readSiteWide` (Admin | Editor | Viewer). Viewer keeps its
 * legitimate site-wide READ; it no longer confers site-wide WRITE.
 */
describe("a read-only role does not grant site-wide write (P1)", () => {
  let s: Suite;
  const raw = createDb(TEST_DB);
  let admin: AccessContext;
  let outsiderPage: string; // a page in NO section this user is scoped to
  let comboCtx: AccessContext; // [Author, Viewer], scoped to one section

  beforeAll(async () => {
    s = await setupApi();
    const rows = (await raw.sql`SELECT id FROM users WHERE email='admin@paperboy.test' LIMIT 1`) as Array<{ id: string }>;
    admin = await getAccessContext(s.app.db, rows[0]!.id);

    const mySection = (await createContent(s.app.db, admin, { type: "LandingPage", locale: "en", name: "Combo Home Section", parentId: null })).documentId;
    outsiderPage = (await createContent(s.app.db, admin, { type: "LandingPage", locale: "en", name: "Someone Elses Section", parentId: null })).documentId;

    const comboId = await createUser(s.app.db, {
      email: "author-viewer@paperboy.test",
      name: "Author plus Viewer",
      password: "Combo!Passw0rd",
      roles: ["Author", "Viewer"],
      sections: [mySection],
    });
    comboCtx = await getAccessContext(s.app.db, comboId);
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  it("cannot UPDATE a document outside its sections", async () => {
    await expect(
      updateContent(s.app.db, comboCtx, outsiderPage, "en", { data: { heading: "owned" } }),
    ).rejects.toThrow(/scope/i);
  });

  it("cannot CREATE a child under a section it is not scoped to", async () => {
    await expect(
      createContent(s.app.db, comboCtx, { type: "LandingPage", locale: "en", name: "Sneaky child", parentId: outsiderPage }),
    ).rejects.toThrow(/scope|not found/i);
  });

  it("KEEPS its legitimate site-wide READ (that is what Viewer is for)", async () => {
    // The whole point of the combination is site-wide review, so reads must not
    // regress: getContent on the out-of-section page succeeds, and listPages
    // returns pages beyond this user's own section.
    const read = await getContent(s.app.db, comboCtx, outsiderPage, "en");
    expect(read.documentId).toBe(outsiderPage);

    const pages = await listPages(s.app.db, comboCtx);
    expect(pages.some((p) => p.documentId === outsiderPage)).toBe(true);
  });

  it("the flags themselves say it: read-wide yes, write-wide no", () => {
    expect(comboCtx.readSiteWide).toBe(true);
    expect(comboCtx.siteWide).toBe(false);
  });
});
