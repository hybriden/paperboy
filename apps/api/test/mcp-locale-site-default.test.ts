import { createDb, createContent, getAccessContext, resolveRequestedLocale, updateContent } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, TEST_DB, authHeaders, login, setupApi } from "./helpers.js";

/**
 * `resolveRequestedLocale` decides the locale for EVERY locale-less MCP write
 * (apps/mcp/src/server.ts `locFor`) and for the AI agent's tools. It read only
 * `locale.isDefault` — never `site.defaultLocale` — so on a site configured for `nb`
 * while the global default was still `en`, a write with no `locale` resolved to `en`
 * and forked a phantom `en` branch.
 *
 * That is precisely the 2026-06-07 incident this function was written to prevent
 * (tags/publishDate landed in a near-empty `en` draft; the `nb` article shipped
 * without them), reintroduced one level up — the HTTP routes were fixed to use
 * `resolveDefaultLocale` while this resolver was not.
 */
describe("resolveRequestedLocale honours the document's own site default", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let nbSiteId: string;
  const raw = createDb(TEST_DB);

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/sites",
      headers: authHeaders(admin),
      payload: { slug: "brand-nb-locale", name: "Brand NB Locale", defaultLocale: "nb" },
    });
    expect(created.statusCode, created.body).toBe(200);
    nbSiteId = created.json().id as string;
  });
  afterAll(async () => {
    await s.app.close();
    await raw.sql.end();
  });

  /** An AccessContext scoped to the nb site, as the MCP would carry. */
  async function nbCtx() {
    const users = (await raw.sql`SELECT id FROM users WHERE email = 'admin@paperboy.test'`) as unknown as {
      id: string;
    }[];
    return { ...(await getAccessContext(raw.db, users[0]!.id, nbSiteId)), via: "mcp" as const };
  }

  /**
   * A BILINGUAL document is the case that actually discriminates. With a single
   * variant the function's "sole locale" fallback already returns it, so the site
   * default never gets consulted — a single-variant test passes either way (verified).
   * With both nb and en present, the old code returned the GLOBAL default (en); the
   * site's own default must win.
   */
  async function bilingualPage(name: string): Promise<string> {
    const ctx = await nbCtx();
    const page = await createContent(raw.db, ctx, { type: "ArticlePage", parentId: null, locale: "nb", name });
    // Add an en variant too, so both branches exist.
    await updateContent(raw.db, ctx, page.documentId, "en", { data: { heading: `${name} (en)` } });
    const codes = (await raw.sql`
      SELECT DISTINCT locale FROM content_version WHERE document_id = ${page.documentId} ORDER BY locale
    `) as unknown as { locale: string }[];
    expect(codes.map((c) => c.locale), "fixture must be bilingual to discriminate").toEqual(["en", "nb"]);
    return page.documentId;
  }

  it("a bilingual doc on an nb site resolves to nb, not the global default en", async () => {
    const documentId = await bilingualPage("Tospraklig artikkel");
    expect(await resolveRequestedLocale(raw.db, documentId)).toBe("nb");
  });

  it("a locale-less write on that doc edits the nb branch, not en", async () => {
    const ctx = await nbCtx();
    const documentId = await bilingualPage("Skriv uten locale");

    const loc = await resolveRequestedLocale(raw.db, documentId);
    await updateContent(raw.db, ctx, documentId, loc, { data: { heading: "Endret uten locale" } });

    const rows = (await raw.sql`
      SELECT locale, data->>'heading' AS heading
      FROM content_version WHERE document_id = ${documentId} AND status = 'draft' ORDER BY locale
    `) as unknown as { locale: string; heading: string | null }[];
    const nb = rows.find((r) => r.locale === "nb");
    const en = rows.find((r) => r.locale === "en");
    expect(nb?.heading, "the nb branch should have received the edit").toBe("Endret uten locale");
    expect(en?.heading, "the en branch must be untouched").not.toBe("Endret uten locale");
  });

  it("an explicit locale still wins over the site default", async () => {
    const ctx = await nbCtx();
    const page = await createContent(raw.db, ctx, {
      type: "ArticlePage",
      parentId: null,
      locale: "nb",
      name: "Eksplisitt",
    });
    expect(await resolveRequestedLocale(raw.db, page.documentId, "en")).toBe("en");
  });

  it("the Default site still resolves to en (no regression for single-site installs)", async () => {
    expect(await resolveRequestedLocale(raw.db, s.ids.homeId)).toBe("en");
  });
});
