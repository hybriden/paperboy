import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * The `revision` token must move whenever the working draft changes, and must be
 * honoured on every path that writes it — not just `updateContent`'s UPDATE branch.
 *
 * Migration 0016 and the schema comment both claim `revision` is "bumped on every
 * in-place draft write". It was bumped in exactly ONE place, and only checked in
 * one branch, so three ordinary editor actions still lost work silently:
 *
 *  (a) RESTORE a version — rewrites the draft in place without bumping, so an
 *      editor holding the pre-restore token saves straight over the restore.
 *  (b) PUBLISH — promotes the draft row away, so the next save takes the INSERT
 *      branch, which ignored `revision` entirely.
 *  (c) DISCARD DRAFT — deletes the draft row, same INSERT branch, same result.
 *
 * All three are one click apart in the admin, and (b)/(c) regress the LIVE page on
 * the next publish. This is the exact class 0016 exists to prevent, one entry
 * point over — the fix was incomplete, not wrong.
 */
describe("revision is enforced on every draft-writing path", () => {
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
    return r.json() as { revision: number; data: Record<string, unknown>; name: string };
  };

  const write = (documentId: string, payload: Record<string, unknown>) =>
    s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${documentId}?locale=en`,
      headers: authHeaders(admin),
      payload,
    });

  const post = (documentId: string, action: string) =>
    s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${documentId}/${action}?locale=en`,
      headers: authHeaders(admin),
    });

  it("(a) restoring a version moves the revision, so a stale save is refused", async () => {
    const id = await newPage("Holes Restore");
    expect((await write(id, { data: { heading: "v1", seoNotes: "note-one" } })).statusCode).toBe(200);
    expect((await post(id, "publish")).statusCode).toBe(200);

    // v2 becomes the working draft.
    const v1 = await read(id);
    expect((await write(id, { data: { heading: "v2-draft" }, revision: v1.revision })).statusCode).toBe(200);

    // Editor A is now looking at v2.
    const stale = await read(id);

    // Editor B restores the published v1.
    const versions = await s.app.inject({
      method: "GET",
      url: `/api/v1/manage/content/${id}/versions?locale=en`,
      headers: authHeaders(admin),
    });
    expect(versions.statusCode, versions.body).toBe(200);
    const list = versions.json() as { id: number; versionNumber: number }[];
    const target = [...list].sort((x, y) => x.versionNumber - y.versionNumber)[0]!;
    const restored = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/versions/${target.id}/restore?locale=en`,
      headers: authHeaders(admin),
    });
    expect(restored.statusCode, restored.body).toBe(200);

    // The restore must have advanced the token...
    expect((await read(id)).revision, "restore did not move the revision").not.toBe(stale.revision);
    // ...so A's stale save is refused instead of erasing the restore.
    const res = await write(id, { data: { heading: "A stale save" }, revision: stale.revision });
    expect(res.statusCode, `a stale save survived a restore: ${res.body.slice(0, 200)}`).toBe(409);
    expect((await read(id)).data.heading).not.toBe("A stale save");
  });

  it("(b) publishing consumes the draft, so a stale save is refused not re-inserted", async () => {
    const id = await newPage("Holes Publish");
    expect((await write(id, { data: { heading: "base", seoNotes: "B's research" } })).statusCode).toBe(200);

    const stale = await read(id);
    expect((await post(id, "publish")).statusCode).toBe(200);

    // The draft row is gone; the old code took the INSERT branch and ignored the token.
    const res = await write(id, { data: { heading: "A stale full replace" }, revision: stale.revision });
    expect(res.statusCode, `stale save after publish: ${res.body.slice(0, 200)}`).toBe(409);
    expect((await read(id)).data.seoNotes, "the published content must not be regressed").toBe("B's research");
  });

  it("(c) discarding the draft also refuses a stale save", async () => {
    const id = await newPage("Holes Discard");
    expect((await write(id, { data: { heading: "published state", seoNotes: "keep" } })).statusCode).toBe(200);
    expect((await post(id, "publish")).statusCode).toBe(200);
    const afterPublish = await read(id);
    expect((await write(id, { data: { heading: "draft edit" }, revision: afterPublish.revision })).statusCode).toBe(200);

    const stale = await read(id);
    const discarded = await post(id, "discard-draft");
    expect(discarded.statusCode, discarded.body).toBe(200);

    const res = await write(id, { data: { heading: "resurrect" }, revision: stale.revision });
    expect(res.statusCode, `stale save after discard: ${res.body.slice(0, 200)}`).toBe(409);
  });

  it("a caller that read a draft-less document (revision 0) still writes", async () => {
    // revision 0 means "there is no draft — expect an insert", which is exactly
    // what the INSERT branch does. It must stay accepted, or every first edit of a
    // published page would 409.
    const id = await newPage("Holes Zero");
    expect((await write(id, { data: { heading: "first" } })).statusCode).toBe(200);
    expect((await post(id, "publish")).statusCode).toBe(200);

    const detail = await read(id);
    expect(detail.revision, "a published-only document reports revision 0").toBe(0);
    const res = await write(id, { data: { heading: "second" }, revision: detail.revision });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("omitting the revision still works on every path (back-compat)", async () => {
    const id = await newPage("Holes Optional");
    expect((await write(id, { data: { heading: "x" } })).statusCode).toBe(200);
    expect((await post(id, "publish")).statusCode).toBe(200);
    expect((await write(id, { data: { heading: "y" } })).statusCode).toBe(200);
  });
});
