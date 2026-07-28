import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * End-to-end proof that the coercion chokepoint now reaches INSIDE content-area
 * blocks on the real write path (not just in the pure unit tests).
 *
 * The reported failure: writing raw Markdown into a block's `richtext` field
 * returned 200 OK and persisted the STRING. Delivery then advertised
 * `fieldTypes.body: "richtext"` with a string value, so the block rendered blank and
 * TipTap opened empty — a silent, destructive success (agent-API rule #1). The same
 * write to a TOP-LEVEL richtext field was correctly parsed into a doc.
 */
describe("content-area inline block data goes through the coercion chokepoint", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  /** A LandingPage (seeded: mainArea accepts HeroBlock/CardBlock/ListBlock). */
  async function newPage(name: string): Promise<string> {
    const r = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: "LandingPage", parentId: null, locale: "en", name },
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().documentId as string;
  }

  const inlineBlock = (inline: Record<string, unknown>) => ({
    key: "blk1",
    blockType: "CardBlock",
    display: "automatic",
    shared: false,
    ref: null,
    inline,
  });

  async function save(documentId: string, data: Record<string, unknown>) {
    return s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${documentId}?locale=en`,
      headers: authHeaders(admin),
      payload: { data },
    });
  }

  async function read(documentId: string): Promise<Record<string, unknown>> {
    const r = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${documentId}?locale=en`,
      headers: authHeaders(admin),
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().data as Record<string, unknown>;
  }

  it("a Markdown string in a block's richtext field is stored as a real doc, not a raw string", async () => {
    const id = await newPage("Inline Coercion MD");
    const res = await save(id, { mainArea: [inlineBlock({ title: "Card", body: "## Heading\n\n**bold**" })] });
    expect(res.statusCode, res.body).toBe(200);

    const data = await read(id);
    const inline = (data.mainArea as Array<{ inline: Record<string, unknown> }>)[0]!.inline;
    expect(typeof inline.body, `body persisted as a raw string: ${JSON.stringify(inline.body)}`).toBe("object");
    expect((inline.body as { type?: string }).type).toBe("doc");
    // Meaning preserved, not glued together: the heading text survives.
    expect(JSON.stringify(inline.body)).toContain("Heading");
  });

  it("a resolved asset object in a block image field is normalized to its documentId", async () => {
    const id = await newPage("Inline Coercion Asset");
    // HeroBlock.heroImage is the seeded image field; the write format is the
    // asset documentId, and agents routinely paste the RESOLVED read shape back.
    const res = await save(id, {
      mainArea: [
        {
          key: "hero1",
          blockType: "HeroBlock",
          display: "automatic",
          shared: false,
          ref: null,
          inline: { title: "Hero", heroImage: { documentId: "asset_abc", url: "/api/v1/media/x.png", alt: "x" } },
        },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);

    const data = await read(id);
    const inline = (data.mainArea as Array<{ inline: Record<string, unknown> }>)[0]!.inline;
    expect(inline.heroImage).toBe("asset_abc");
  });

  it("top-level and in-block richtext behave IDENTICALLY (the asymmetry is gone)", async () => {
    const id = await newPage("Inline Coercion Parity");
    const md = "## Same input\n\ntext";
    const res = await save(id, { intro: md, mainArea: [inlineBlock({ body: md })] });
    expect(res.statusCode, res.body).toBe(200);

    const data = await read(id);
    const inline = (data.mainArea as Array<{ inline: Record<string, unknown> }>)[0]!.inline;
    expect((data.intro as { type?: string })?.type).toBe("doc");
    expect((inline.body as { type?: string })?.type).toBe("doc");
  });
});
