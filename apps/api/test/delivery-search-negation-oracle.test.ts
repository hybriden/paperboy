import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Search must not leak private field text through NEGATED terms.
 *
 * The SQL prefilter matches `v.fts`, which is built from the whole `data` JSONB —
 * including `delivery:"private"` fields. `websearch_to_tsquery` honours `-term`,
 * and the leak-safety re-check deliberately dropped negated words
 * (`.filter((w) => !w.startsWith("-"))`), re-verifying only POSITIVE terms
 * against sanitized public text.
 *
 * So an exclusion caused by a private match was never undone, turning the public
 * delivery key into a word-membership oracle over private content:
 *
 *   ?q=Kiwifruit              → [A, B]   baseline
 *   ?q=Kiwifruit -bluewhale   → [B]      ⇒ "bluewhale" is in A's PRIVATE text
 *   ?q=Kiwifruit -redfox      → [A]      ⇒ "redfox" is in B's PRIVATE text
 *   ?q=Kiwifruit -seoNotes    → []       ⇒ even the private JSON KEY is queryable
 *
 * One word per request, dictionary-walkable, with a credential that ships inside
 * every frontend build. This is exactly what the code's own comment claimed to
 * prevent — the mitigation only ever covered the positive direction.
 *
 * The fix makes negation a PUBLIC-text operation: negated words are stripped
 * before the SQL tsquery is built, and applied against the sanitized public text
 * instead, so a private match can neither include nor exclude a document.
 */
describe("search negation cannot probe private fields", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  /** A published ArticlePage with shared PUBLIC text and unique PRIVATE text. */
  async function article(name: string, privateWord: string): Promise<string> {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: "ArticlePage", parentId: null, locale: "en", name },
    });
    expect(created.statusCode, created.body).toBe(200);
    const documentId = created.json().documentId as string;

    const saved = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${documentId}?locale=en`,
      headers: authHeaders(admin),
      // heading is public; seoNotes is delivery:"private" (see the seed).
      payload: { data: { heading: `Kiwifruit ${name}`, seoNotes: `codename ${privateWord}` } },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const published = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${documentId}/publish?locale=en`,
      headers: authHeaders(admin),
    });
    expect(published.statusCode, published.body).toBe(200);
    return documentId;
  }

  let a: string;
  let b: string;
  beforeAll(async () => {
    a = await article("Alpha", "bluewhale");
    b = await article("Beta", "redfox");
  });

  const search = async (q: string): Promise<string[]> => {
    const res = await s.app.inject({ method: "GET", url: `/api/v1/delivery/search?q=${encodeURIComponent(q)}&limit=20`, headers: pub });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().items as { documentId: string }[]).map((i) => i.documentId);
  };

  it("the private text is genuinely absent from delivery output (fixture sanity)", async () => {
    const res = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${a}`, headers: pub });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("bluewhale");
    expect(res.body).not.toContain("seoNotes");
  });

  it("both documents match on their shared PUBLIC word (baseline)", async () => {
    const ids = await search("Kiwifruit");
    expect(ids).toContain(a);
    expect(ids).toContain(b);
  });

  it("negating a word that exists ONLY in private text changes nothing", async () => {
    // The leak: this used to return [B] for -bluewhale and [A] for -redfox.
    for (const [word, other] of [
      ["bluewhale", b],
      ["redfox", a],
    ] as const) {
      const ids = await search(`Kiwifruit -${word}`);
      expect(ids, `-${word} leaked which document holds it`).toContain(a);
      expect(ids, `-${word} leaked which document holds it`).toContain(b);
      expect(other).toBeTruthy();
    }
  });

  it("negating a word shared by both private values does not empty the result", async () => {
    const ids = await search("Kiwifruit -codename");
    expect(ids).toContain(a);
    expect(ids).toContain(b);
  });

  it("negating a private FIELD NAME does not empty the result", async () => {
    expect(await search("Kiwifruit -seoNotes")).toHaveLength(2);
  });

  it("a private-only word finds nothing on its own (positive direction still safe)", async () => {
    expect(await search("bluewhale")).toHaveLength(0);
  });

  it("negation still works on PUBLIC text", async () => {
    // The feature must survive the fix: Alpha/Beta are public heading words.
    const ids = await search("Kiwifruit -Alpha");
    expect(ids, "public negation should exclude Alpha").not.toContain(a);
    expect(ids, "public negation should keep Beta").toContain(b);
  });

  it("a control word absent everywhere excludes nothing", async () => {
    const ids = await search("Kiwifruit -nosuchwordanywhere");
    expect(ids).toHaveLength(2);
  });
});
