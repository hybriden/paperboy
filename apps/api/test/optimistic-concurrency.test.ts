import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * Two editors on one document must not silently destroy each other's work.
 *
 * `updateContent` mutates the single working draft IN PLACE, and `PUT
 * /manage/content/:id` carries no notion of which version the caller was looking
 * at. The admin editor autosaves the WHOLE `data` map from the snapshot it loaded
 * on mount and never re-reads it, so:
 *
 *   A opens the page → B opens it, writes `seoNotes`, saves → A types in
 *   `heading` and autosaves → B's `seoNotes` is gone.
 *
 * Nothing reports it. The draft row was overwritten rather than superseded, so
 * B's text is not in version history either — it is unrecoverable, and B only
 * finds out by noticing. The same path silently discards an MCP agent's write
 * (and clears the `needsReview` flag that was the human's signal to look).
 *
 * The fix is a revision token: read it with the content, send it back on write,
 * and get a 409 instead of a clobber when the draft moved underneath you.
 */
describe("optimistic concurrency on the working draft", () => {
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

  const read = async (documentId: string) => {
    const r = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${documentId}?locale=en`,
      headers: authHeaders(admin),
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { revision: number; data: Record<string, unknown> };
  };

  const write = (documentId: string, payload: Record<string, unknown>) =>
    s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${documentId}?locale=en`,
      headers: authHeaders(admin),
      payload,
    });

  it("hands out a revision with the content", async () => {
    const id = await newPage("Concurrency Revision");
    const before = await read(id);
    expect(typeof before.revision).toBe("number");

    const res = await write(id, { data: { heading: "First" }, revision: before.revision });
    expect(res.statusCode, res.body).toBe(200);
    // The token must MOVE on every write, or a stale one keeps validating.
    expect((await read(id)).revision).not.toBe(before.revision);
  });

  it("REFUSES a write from a stale snapshot instead of clobbering", async () => {
    const id = await newPage("Concurrency Lost Update");
    const stale = await read(id); // editor A loads the page

    // Editor B loads, writes seoNotes, saves.
    const b = await read(id);
    expect(await write(id, { data: { seoNotes: "B's research" }, revision: b.revision }).then((r) => r.statusCode)).toBe(200);

    // Editor A autosaves its FULL data map, still holding the pre-B snapshot.
    const res = await write(id, { data: { heading: "A's title" }, revision: stale.revision });
    expect(res.statusCode, "a stale full-replace must not succeed").toBe(409);

    // B's work survived.
    expect((await read(id)).data.seoNotes).toBe("B's research");
  });

  it("the 409 is self-teaching: says what happened and what to do (rule #2)", async () => {
    const id = await newPage("Concurrency Message");
    const stale = await read(id);
    await write(id, { data: { seoNotes: "moved on" }, revision: stale.revision });

    const res = await write(id, { data: { heading: "clobber" }, revision: stale.revision });
    const message = res.json().message as string;
    expect(message).toMatch(/chang|modif|since/i);
    expect(message).toMatch(/re-?read|reload|GET/i);
    expect(res.json().error).toBe("conflict");
  });

  it("a correct revision chain saves repeatedly", async () => {
    const id = await newPage("Concurrency Chain");
    for (const heading of ["one", "two", "three"]) {
      const cur = await read(id);
      const res = await write(id, { data: { heading }, revision: cur.revision });
      expect(res.statusCode, res.body).toBe(200);
    }
    expect((await read(id)).data.heading).toBe("three");
  });

  it("stays backwards compatible: a caller that sends no revision still writes", async () => {
    // The published Management API contract and every existing MCP/script client
    // omit it. Refusing those would be a breaking change; they keep last-write-wins.
    const id = await newPage("Concurrency Optional");
    const res = await write(id, { data: { heading: "no token" } });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("does not fire on a merge write (it reads current data at write time)", async () => {
    const id = await newPage("Concurrency Merge");
    const stale = await read(id);
    await write(id, { data: { seoNotes: "keep me" }, revision: stale.revision });

    // merge:true re-reads the working draft, so a stale token is not a hazard for
    // the fields the caller didn't send — but it must still refuse if asked to check.
    const res = await write(id, { data: { heading: "merged" }, merge: true });
    expect(res.statusCode, res.body).toBe(200);
    const after = await read(id);
    expect(after.data.seoNotes).toBe("keep me");
    expect(after.data.heading).toBe("merged");
  });

  it("a mismatched revision leaves the stored draft completely untouched", async () => {
    const id = await newPage("Concurrency No Partial");
    const stale = await read(id);
    await write(id, { data: { heading: "B wrote this", seoNotes: "and this" }, revision: stale.revision });
    const afterB = await read(id);

    await write(id, { data: { heading: "A clobber" }, revision: stale.revision });
    const afterA = await read(id);
    expect(afterA.data).toEqual(afterB.data);
    expect(afterA.revision).toBe(afterB.revision);
  });
});
