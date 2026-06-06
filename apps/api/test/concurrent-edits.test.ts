import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * CONTRACT FREEZE — concurrent / interleaved editing semantics.
 *
 * SURPRISING-BUT-PINNED: the Management PUT /content/:id route does NOT default
 * to merge (unlike MCP update_content). `merge` is an optional flag with no
 * default, so an ordinary PUT REPLACES the whole working `data` map. Two
 * sequential PUTs from two sessions are therefore last-write-wins, and a PUT that
 * omits a field DROPS it from the draft. With `merge:true` the patch is
 * shallow-merged over the current working draft instead.
 */

const pub = { authorization: `Bearer ${PUBLIC_KEY}` };

describe("Concurrent / interleaved edits", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let editor: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    editor = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  /** Create a fresh ArticlePage draft (as admin) and return its documentId. */
  async function freshPage(name: string): Promise<string> {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/content",
      headers: authHeaders(admin),
      payload: { type: "ArticlePage", locale: "en", name },
    });
    expect(res.statusCode).toBe(200);
    return res.json().documentId as string;
  }

  it("two sessions PUT the same draft → last-write-wins, full REPLACE drops omitted fields", async () => {
    const id = await freshPage("Concurrent Draft");

    // Admin writes heading + intro.
    const a = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(admin),
      payload: { data: { heading: "Admin heading", canonicalUrl: "https://a.example" } },
    });
    expect(a.statusCode).toBe(200);
    expect(a.json().data.heading).toBe("Admin heading");
    expect(a.json().data.canonicalUrl).toBe("https://a.example");

    // Editor writes ONLY heading (no merge flag) → full replace.
    const b = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(editor),
      payload: { data: { heading: "Editor heading" } },
    });
    expect(b.statusCode).toBe(200);
    // Last write wins.
    expect(b.json().data.heading).toBe("Editor heading");
    // The field the editor omitted is GONE — full replace, not merge.
    expect(b.json().data.canonicalUrl).toBeUndefined();

    // Re-read confirms the single shared working draft holds the editor's state.
    const read = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}?locale=en`, headers: { cookie: admin.cookie } });
    expect(read.json().data.heading).toBe("Editor heading");
    expect(read.json().data.canonicalUrl).toBeUndefined();
    // Both edits target the SAME draft (single-draft invariant), not a fork.
    expect(read.json().status).toBe("draft");
  });

  it("merge:true shallow-merges over the current working draft (preserves untouched fields)", async () => {
    const id = await freshPage("Mergeable Draft");

    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(admin),
      payload: { data: { heading: "Base heading", canonicalUrl: "https://keep.example" } },
    });
    const merged = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(editor),
      payload: { merge: true, data: { heading: "Patched heading" } },
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().data.heading).toBe("Patched heading");
    // The untouched field SURVIVES under merge.
    expect(merged.json().data.canonicalUrl).toBe("https://keep.example");
  });

  it("update → publish → update again: draft and published versions stay separated under interleaving", async () => {
    const id = await freshPage("Lifecycle Page");

    // 1) Draft v1 (required heading set so publish is valid).
    await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(admin),
      payload: { data: { heading: "Published heading" } },
    });

    // 2) Publish — promotes the draft to the current published version.
    const published = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${id}/publish?locale=en`,
      headers: authHeaders(admin),
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().status).toBe("published");

    // Delivery (public) now serves the published heading.
    const deliv1 = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: pub });
    expect(deliv1.statusCode).toBe(200);
    expect(deliv1.json().data.heading).toBe("Published heading");

    // 3) A second editor edits again → a NEW draft, published copy untouched.
    const edited = await s.app.inject({
      method: "PUT",
      url: `/api/v1/manage/content/${id}?locale=en`,
      headers: authHeaders(editor),
      payload: { data: { heading: "Draft-only heading" } },
    });
    expect(edited.statusCode).toBe(200);
    // PINNED: `status` reflects whether a CURRENT-PUBLISHED version exists, not
    // the version just written — so it stays "published" while the unpublished
    // draft is flagged separately via hasUnpublishedChanges.
    expect(edited.json().status).toBe("published");
    expect(edited.json().hasUnpublishedChanges).toBe(true);

    // Public delivery still shows the PUBLISHED heading (draft is invisible).
    const deliv2 = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${id}?locale=en`, headers: pub });
    expect(deliv2.json().data.heading).toBe("Published heading");

    // The management read (working view) shows the new draft heading, while
    // status remains "published" with unpublished changes pending.
    const draftRead = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${id}?locale=en`, headers: { cookie: admin.cookie } });
    expect(draftRead.json().data.heading).toBe("Draft-only heading");
    expect(draftRead.json().status).toBe("published");
    expect(draftRead.json().hasUnpublishedChanges).toBe(true);
  });
});
