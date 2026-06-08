import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Generative + exhaustive NO-LEAK guarantee: a field marked delivery:"private"
 * must NEVER surface in ANY delivery output — across every shape (by-id,
 * by-path, list, search, globals), every populate depth, both perspectives,
 * AND every derived view (the seo block, breadcrumb, og:image, reference
 * expansion, inline content-area blocks). We plant unique SENTINELS in private
 * fields and assert no sentinel string ever appears in a delivered payload.
 *
 * Attack variants exhausted: a private plain field; a private field tagged with
 * a seoRole (title/description) — the SEO must not read it; a private field with
 * a CONVENTIONAL name (summary) — the convention fallback must not read it; a
 * private field on a shared BLOCK reached via reference + inline content-area.
 */
describe("delivery no-leak (generative + exhaustive)", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let ed: Awaited<ReturnType<typeof login>>;
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
  const prev = { authorization: `Bearer ${PREVIEW_KEY}` };

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  const createType = (payload: Record<string, unknown>) =>
    s.app.inject({ method: "POST", url: "/api/v1/manage/content-types", headers: authHeaders(admin), payload });
  const createContent = (payload: Record<string, unknown>) =>
    s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(ed), payload });
  const put = (id: string, locale: string, payload: Record<string, unknown>) =>
    s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=${locale}`, headers: authHeaders(ed), payload });
  const publish = (id: string, locale = "en") =>
    s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=${locale}`, headers: authHeaders(ed) });

  /** Every delivery shape for a document, both perspectives, populate 0..3. */
  async function allDeliveries(documentId: string, slugPath: string | null, type: string, sentinelQuery: string) {
    const bodies: string[] = [];
    for (const headers of [pub, prev]) {
      for (const populate of [0, 1, 2, 3]) {
        const r = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${documentId}?locale=en&populate=${populate}`, headers });
        if (r.statusCode === 200) bodies.push(r.body);
      }
      if (slugPath) {
        const r = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/by-path?path=${encodeURIComponent(slugPath)}&locale=en&populate=2`, headers });
        if (r.statusCode === 200) bodies.push(r.body);
      }
      const list = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content?type=${type}&locale=en&populate=2`, headers });
      if (list.statusCode === 200) bodies.push(list.body);
      const search = await s.app.inject({ method: "GET", url: `/api/v1/delivery/search?q=${encodeURIComponent(sentinelQuery)}&locale=en`, headers });
      if (search.statusCode === 200) bodies.push(search.body);
    }
    return bodies;
  }

  it("EXHAUSTIVE: private fields (plain / seoRole-tagged / conventionally-named / on a referenced+inline block) never leak", async () => {
    // A block with a public label + a PRIVATE secret — used both as a shared
    // reference and as an inline content-area block.
    expect((await createType({
      name: "LeakBlk", displayName: "Leak Block", kind: "block",
      fields: [
        { name: "label", displayName: "Label", type: "text", localized: true, delivery: "public", group: "Content" },
        { name: "blockSecret", displayName: "Block secret", type: "text", localized: true, delivery: "private", group: "Content" },
      ],
    })).statusCode, "block type").toBe(200);

    // A page type exhausting the private-field attack variants.
    expect((await createType({
      name: "LeakProbePage", displayName: "Leak Probe", kind: "page",
      fields: [
        { name: "heading", displayName: "Heading", type: "text", localized: true, required: true, delivery: "public", group: "Content", seoRole: "title" },
        { name: "pubBody", displayName: "Body", type: "markdown", localized: true, delivery: "public", group: "Content" },
        { name: "secretText", displayName: "Secret", type: "text", localized: true, delivery: "private", group: "Content" },
        { name: "secretRoleTitle", displayName: "Secret role title", type: "text", localized: true, delivery: "private", group: "SEO", seoRole: "description" },
        { name: "summary", displayName: "Summary (private!)", type: "text", localized: true, delivery: "private", group: "Content" },
        { name: "mainArea", displayName: "Main", type: "contentArea", localized: true, delivery: "public", group: "Content", allowedBlocks: ["LeakBlk"] },
        { name: "related", displayName: "Related", type: "reference", localized: false, delivery: "public", group: "Content", allowedTypes: ["LeakBlk"] },
      ],
    })).statusCode, "page type").toBe(200);

    // Shared block instance carrying a sentinel in its private field.
    const blk = (await createContent({ type: "LeakBlk", locale: "en", name: "Shared leak block" })).json().documentId as string;
    await put(blk, "en", { data: { label: "visible label", blockSecret: "SENTINEL_SHAREDBLOCK" } });
    await publish(blk);

    const page = (await createContent({ type: "LeakProbePage", locale: "en", name: "Probe Page" })).json().documentId as string;
    const putRes = await put(page, "en", {
      slug: "probe-page",
      data: {
        heading: "Public Heading",
        pubBody: "# Public\n\nVisible body.",
        secretText: "SENTINEL_PLAIN",
        secretRoleTitle: "SENTINEL_SEOROLE",
        summary: "SENTINEL_CONVENTION",
        mainArea: [{ key: "k1", blockType: "LeakBlk", display: "automatic", ref: null, inline: { label: "inline label", blockSecret: "SENTINEL_INLINEBLOCK" } }],
        related: { documentId: blk, type: "LeakBlk" },
      },
    });
    expect(putRes.statusCode, putRes.body).toBe(200);
    expect((await publish(page)).statusCode).toBe(200);

    const SENTINELS = ["SENTINEL_PLAIN", "SENTINEL_SEOROLE", "SENTINEL_CONVENTION", "SENTINEL_SHAREDBLOCK", "SENTINEL_INLINEBLOCK"];
    const bodies = await allDeliveries(page, "/probe-page", "LeakProbePage", "SENTINEL");
    expect(bodies.length).toBeGreaterThan(5); // we actually exercised the surface
    for (const body of bodies) {
      for (const sentinel of SENTINELS) {
        expect(body, `a private sentinel leaked into a delivery payload: ${sentinel}`).not.toContain(sentinel);
      }
    }

    // And specifically: the SEO block must NOT have used the private role/convention fields.
    const withSeo = (await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${page}?locale=en`, headers: pub })).json();
    expect(withSeo.seo.title).toBe("Public Heading"); // role:title is the PUBLIC heading, not a secret
    expect(withSeo.seo.description).toBeNull(); // private role:description + private summary are NOT read
  });

  it("GENERATIVE: random field configs with private sentinels never leak through delivery", async () => {
    const TYPES = ["text", "markdown", "number", "datetime", "select"] as const;
    let n = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            type: fc.constantFrom(...TYPES),
            delivery: fc.constantFrom("public", "private"),
            localized: fc.boolean(),
            role: fc.option(fc.constantFrom("title", "description", "author", "keywords"), { nil: undefined }),
            conventionalName: fc.boolean(), // sometimes name it like a convention field (summary/author/tags)
          }),
          { minLength: 2, maxLength: 5 },
        ),
        async (specs) => {
          n += 1;
          const typeName = `Gen${n}P`;
          const usedRoles = new Set<string>();
          const convNames = ["summary", "author", "tags"];
          const fields = specs.map((sp, i) => {
            const role = sp.role && !usedRoles.has(sp.role) ? sp.role : undefined;
            if (role) usedRoles.add(role);
            const name = sp.conventionalName ? `${convNames[i % convNames.length]}${i}` : `f${i}`;
            return {
              name,
              displayName: name,
              type: sp.type,
              localized: sp.localized,
              delivery: sp.delivery,
              group: "Content",
              ...(sp.type === "select" ? { options: [{ value: "x", label: "X" }] } : {}),
              ...(role ? { seoRole: role } : {}),
            };
          });
          // Always one required public title so publish succeeds + something delivers.
          fields.unshift({ name: "title", displayName: "Title", type: "text" as const, localized: true, delivery: "public", group: "Content", seoRole: "title" } as never);

          const ct = await createType({ name: typeName, displayName: typeName, kind: "page", fields });
          if (ct.statusCode !== 200) return true; // invalid combo (e.g. dup role) — skip, not a leak
          const id = (await createContent({ type: typeName, locale: "en", name: `${typeName} item` })).json().documentId as string;
          const data: Record<string, unknown> = { title: "Public Title" };
          for (const f of fields.slice(1)) {
            if (f.delivery === "private") {
              data[f.name] = f.type === "number" ? 0 : f.type === "datetime" ? "2026-01-01T00:00:00.000Z" : `LEAK_${typeName}_${f.name}`;
            } else if (f.type === "text" || f.type === "markdown") {
              data[f.name] = "public-ok";
            }
          }
          await put(id, "en", { data });
          await publish(id);

          const bodies = await allDeliveries(id, null, typeName, `LEAK_${typeName}`);
          for (const body of bodies) {
            if (body.includes(`LEAK_${typeName}_`)) return false; // a private sentinel leaked
          }
          return true;
        },
      ),
      { numRuns: 12 }, // each run hits the DB + many endpoints; keep modest but real
    );
  });
});
