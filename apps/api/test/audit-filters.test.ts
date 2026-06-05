import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/** Audit log: server-side filters (action prefix, documentId, time range) + cursor paging. */
describe("audit log filters + paging", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    // Generate a few audit entries of different kinds.
    for (let i = 0; i < 3; i++) {
      const r = await s.app.inject({
        method: "PUT",
        url: `/api/v1/manage/content/${s.ids.homeId}?locale=en`,
        headers: authHeaders(admin),
        payload: { merge: true, data: { heading: `Audit ping ${i}` } },
      });
      expect(r.statusCode).toBe(200);
    }
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("filters by action prefix", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/v1/manage/audit?action=content.", headers: authHeaders(admin) });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ action: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.action.startsWith("content."))).toBe(true);
  });

  it("filters by documentId", async () => {
    const res = await s.app.inject({ method: "GET", url: `/api/v1/manage/audit?documentId=${s.ids.homeId}`, headers: authHeaders(admin) });
    const rows = res.json() as Array<{ documentId: string | null }>;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.documentId === s.ids.homeId)).toBe(true);
  });

  it("filters by time range (future from → empty)", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const res = await s.app.inject({ method: "GET", url: `/api/v1/manage/audit?from=${encodeURIComponent(future)}`, headers: authHeaders(admin) });
    expect(res.json()).toHaveLength(0);
  });

  it("pages with the before cursor (no overlap, descending ids)", async () => {
    const page1 = (await s.app.inject({ method: "GET", url: "/api/v1/manage/audit?limit=2", headers: authHeaders(admin) })).json() as Array<{ id: number }>;
    expect(page1).toHaveLength(2);
    const page2 = (await s.app.inject({ method: "GET", url: `/api/v1/manage/audit?limit=2&before=${page1[1]!.id}`, headers: authHeaders(admin) })).json() as Array<{ id: number }>;
    const ids = [...page1, ...page2].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // no overlap
    expect([...ids].sort((a, b) => b - a)).toEqual(ids); // newest first
  });
});
