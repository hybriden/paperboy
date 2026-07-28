import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * A large-but-legal document must stay saveable.
 *
 * `to_tsvector` hard-errors above 1048575 input bytes. Migration 0017 made the
 * search vector a GENERATED column over `name || ' ' || data::text`, so once a
 * document's stored JSONB crosses ~1MB EVERY subsequent write to it fails inside
 * Postgres:
 *
 *     ERROR: string is too long for tsvector (1327824 bytes, max 1048575 bytes)
 *
 * Fastify's 1MiB bodyLimit does not prevent it — `merge:true` accumulates across
 * requests, so two ~484KB field writes get there. The caller saw an opaque
 * `{"error":"internal_error"}` 500 with no hint, and the document could never be
 * edited again: a permanent, unrecoverable dead end reachable by ordinary use
 * (a long article with several rich fields), and a rule #2 violation on a fully
 * deterministic input.
 *
 * This also matters more than it did pre-0017: the expression index could be
 * dropped to recover, but a generated column is part of the table.
 */
describe("a document larger than the tsvector limit still saves", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  async function newPage(name: string): Promise<string> {
    const r = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: "ArticlePage", parentId: null, locale: "en", name },
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().documentId as string;
  }

  const write = (documentId: string, data: Record<string, unknown>) =>
    s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${documentId}?locale=en`,
      headers: authHeaders(admin),
      payload: { data, merge: true },
      // The default 1MiB body limit is the point: each request stays under it.
    });

  /**
   * ~640KB of DISTINCT words (each request stays under the 1MiB body limit).
   *
   * Distinctness is the whole point: the limit is on the tsvector's total lexeme
   * bytes, not the input length. A first attempt at this test used
   * `"gamma ".repeat(n)`, which collapses to ONE lexeme — 1.3MB of input produced
   * a 919-byte vector and the test passed while proving nothing.
   */
  const chunk = (marker: string, from: number) =>
    Array.from({ length: 80_000 }, (_, i) => `${marker}${from + i}`).join(" ");

  /** Max total lexeme bytes in one tsvector (Postgres MAXSTRPOS). */
  const TSVECTOR_MAX_BYTES = 1_048_575;

  it("accumulates past the tsvector input limit without a 500", async () => {
    const id = await newPage("Large Doc Accumulate");

    const w1 = await write(id, { seoNotes: chunk("alpha", 0) });
    expect(w1.statusCode, `first write: ${w1.body.slice(0, 400)}`).toBe(200);
    expect((await write(id, { intro: chunk("beta", 1_000_000) })).statusCode).toBe(200);

    // This is the write that used to fail: the generated tsvector for the whole
    // row now exceeds Postgres's limit. Assert we really crossed it, so the test
    // can't pass by staying safely under the boundary it exists to probe.
    const third = await write(id, { heading: chunk("gamma", 2_000_000) });
    expect(third.statusCode, `third write: ${third.body.slice(0, 300)}`).toBe(200);

    const sized = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(admin),
    });
    const storedBytes = Buffer.byteLength(JSON.stringify(sized.json().data));
    expect(storedBytes, "fixture must exceed the limit to be meaningful").toBeGreaterThan(TSVECTOR_MAX_BYTES);

    // And the document must remain editable afterwards — the old failure was
    // permanent, not transient.
    const fourth = await write(id, { heading: "Still editable" });
    expect(fourth.statusCode, fourth.body).toBe(200);

    const read = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(admin),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data.heading).toBe("Still editable");
  });

  it("stays findable by its NAME even when the vector had to be truncated", async () => {
    // Truncating the indexed vector is a search-recall trade, not a data change:
    // the stored content is complete, only the tail is unindexed. On that path a
    // flat prefix would be carved up by JSONB key order — an alphabetically early
    // field can consume the whole budget — so the NAME is indexed unconditionally
    // and is the one thing this test may rely on.
    const id = await newPage("Kvitfjell Large Searchable");
    await write(id, { heading: "A Heading", intro: chunk("delta", 3_000_000) });

    const pub = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/publish?locale=en`,
      headers: authHeaders(admin),
    });
    expect(pub.statusCode, pub.body).toBe(200);

    const res = await s.app.inject({
      method: "GET",
      url: "/api/v1/delivery/search?q=Kvitfjell&limit=5",
      headers: { authorization: `Bearer ${PUBLIC_KEY}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json().items as { documentId: string }[]).some((i) => i.documentId === id)).toBe(true);
  });
});
