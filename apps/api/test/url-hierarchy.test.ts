import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, authHeaders, login, setupApi } from "./helpers.js";

const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
const prev = { authorization: `Bearer ${PREVIEW_KEY}` };

describe("Structure: page tree, asset pane, URL hierarchy", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let aboutId: string;
  let teamId: string;

  async function makePage(parentId: string | null, name: string, slug: string, publish: boolean) {
    const created = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "StandardPage", parentId, locale: "en", name } });
    const id = created.json().documentId;
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin), payload: { slug, data: { heading: name } } });
    if (publish) await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${id}/publish?locale=en`, headers: authHeaders(admin) });
    return id;
  }

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    // Build under the seeded start page "Home" (slug "home"): Home → About → Team.
    aboutId = await makePage(s.ids.homeId, "About", "about", true);
    teamId = await makePage(aboutId, "Team", "team", true);
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("the content pane (tree) contains PAGES only — shared blocks are NOT in it", async () => {
    const tree = await s.app.inject({ method: "GET", url: "/api/v1/manage/content/tree", headers: { cookie: admin.cookie } });
    const nodes = tree.json() as Array<{ documentId: string; kind: string }>;
    expect(nodes.every((n) => n.kind === "page")).toBe(true);
    expect(nodes.some((n) => n.documentId === s.ids.cardId)).toBe(false); // the shared CardBlock is absent
  });

  it("the asset pane lists shared blocks (kind=block) with per-locale status", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/blocks", headers: { cookie: admin.cookie } });
    const blocks = res.json() as Array<{ documentId: string; type: string; locales: Record<string, unknown> }>;
    expect(blocks.some((b) => b.documentId === s.ids.cardId)).toBe(true);
    expect(blocks.every((b) => b.type)).toBe(true);
  });

  it("builds a hierarchical URL from the page structure (start → child → grandchild)", async () => {
    // Editor preview path (computePath via ContentDetail.urlPath)
    const team = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${teamId}?locale=en`, headers: { cookie: admin.cookie } });
    expect(team.json().urlPath).toBe("/home/about/team");

    // Delivery resolves that hierarchical path to the grandchild.
    const byPath = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content/by-path?path=/home/about/team&locale=en", headers: pub });
    expect(byPath.statusCode).toBe(200);
    expect(byPath.json().documentId).toBe(teamId);
    expect(byPath.json().data.heading).toBe("Team");
  });

  it("no-leak survives path-walking: a draft-only ancestor is unreachable under the public key", async () => {
    const draftParent = await makePage(s.ids.homeId, "Draft Parent", "draftp", false); // NOT published
    const kid = await makePage(draftParent, "Kid", "kid", true); // published, but parent is draft

    // Public: cannot traverse the draft ancestor.
    const p1 = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content/by-path?path=/home/draftp&locale=en", headers: pub });
    expect(p1.statusCode).toBe(404);
    const p2 = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content/by-path?path=/home/draftp/kid&locale=en", headers: pub });
    expect(p2.statusCode).toBe(404);

    // Preview: the same path resolves (draft-aware perspective).
    const pv = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content/by-path?path=/home/draftp/kid&locale=en", headers: prev });
    expect(pv.statusCode).toBe(200);
    expect(pv.json().documentId).toBe(kid);
  });

  it("paths are per-locale (the English path 404s under a different locale's segments)", async () => {
    // Home's nb slug is "hjem", so /home/... is not an nb path.
    const nb = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content/by-path?path=/home/about/team&locale=nb", headers: pub });
    expect(nb.statusCode).toBe(404);
  });

  it("rejects duplicate URL segments among page siblings (409)", async () => {
    await makePage(s.ids.homeId, "First Dup", "dup", false);
    const second = await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "StandardPage", parentId: s.ids.homeId, locale: "en", name: "Second Dup" } });
    const id = second.json().documentId;
    const save = await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin), payload: { slug: "dup", data: { heading: "Second" } } });
    expect(save.statusCode).toBe(409);
  });

  it("renaming a parent's URL segment changes the child's resolved path", async () => {
    // Rename About → "company" and re-publish.
    await s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${aboutId}?locale=en`, headers: authHeaders(admin), payload: { slug: "company", data: { heading: "About" } } });
    await s.app.inject({ method: "POST", url: `/api/v1/manage/content/${aboutId}/publish?locale=en`, headers: authHeaders(admin) });

    const team = await s.app.inject({ method: "GET", url: `/api/v1/manage/content/${teamId}?locale=en`, headers: { cookie: admin.cookie } });
    expect(team.json().urlPath).toBe("/home/company/team");

    const fresh = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content/by-path?path=/home/company/team&locale=en", headers: pub });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().documentId).toBe(teamId);

    const stale = await s.app.inject({ method: "GET", url: "/api/v1/delivery/content/by-path?path=/home/about/team&locale=en", headers: pub });
    expect(stale.statusCode).toBe(404);
  });
});
