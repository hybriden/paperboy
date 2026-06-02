import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

describe("Tree reorder (move endpoint)", () => {
  let s: Suite;
  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await s.app.close();
  });

  async function order(cookie: string): Promise<string[]> {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/content/tree", headers: { cookie } });
    return (res.json() as Array<{ documentId: string }>).map((n) => n.documentId);
  }

  it("reorders siblings and persists sortIndex", async () => {
    const ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    const before = await order(ed.cookie);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const [first, second] = before;

    // Move the 2nd item to the front (before the 1st).
    const res = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${second}/move`,
      headers: authHeaders(ed),
      payload: { beforeId: first },
    });
    expect(res.statusCode).toBe(200);

    const after = await order(ed.cookie);
    expect(after.indexOf(second!)).toBeLessThan(after.indexOf(first!));
  });

  it("requires content.update (Viewer denied) and a CSRF token", async () => {
    const before = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
    const ids = await order(before.cookie);

    const viewer = await login(s.app, "viewer@paperboy.test", "Viewer!Passw0rd");
    const denied = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${ids[0]}/move`,
      headers: authHeaders(viewer),
      payload: { afterId: ids[1] },
    });
    expect(denied.statusCode).toBe(403);

    // Missing CSRF token.
    const noCsrf = await s.app.inject({
      method: "POST",
      url: `/api/v1/manage/content/${ids[0]}/move`,
      headers: { cookie: before.cookie, origin: "http://localhost:8090" },
      payload: { afterId: ids[1] },
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});
