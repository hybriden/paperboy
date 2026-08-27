import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

/**
 * A datetime field validated as `z.string()` accepted any string — "next
 * tuesday" survived coercion AND publish, then landed in JSON-LD datePublished
 * (invalid schema.org) and was string-compared by child_sort. It is checked
 * against ISO 8601 now (datetime-local or full offset), empty allowed.
 */
describe("datetime fields reject non-ISO values (P7)", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const def = {
      name: "DateProbePage",
      displayName: "Date Probe Page",
      kind: "page",
      fields: [{ name: "when", displayName: "When", type: "datetime", delivery: "public" }],
    };
    expect((await s.app.inject({ method: "POST", url: "/api/v1/manage/content-types", headers: authHeaders(admin), payload: def })).statusCode).toBe(200);
  });
  afterAll(async () => {
    await s.app.close();
  });

  const mk = async () => (await s.app.inject({ method: "POST", url: "/api/v1/manage/content", headers: authHeaders(admin), payload: { type: "DateProbePage", locale: "en", name: "d" } })).json().documentId as string;
  const save = (id: string, when: string) => s.app.inject({ method: "PUT", url: `/api/v1/manage/content/${id}?locale=en`, headers: authHeaders(admin), payload: { data: { when } } });

  it("rejects a free-text date", async () => {
    const res = await save(await mk(), "next tuesday");
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/ISO|8601|date/i);
  });

  it("accepts a full-offset ISO instant", async () => {
    expect((await save(await mk(), "2026-06-07T12:00:00.000Z")).statusCode).toBe(200);
  });

  it("accepts a datetime-local value (no seconds, no offset)", async () => {
    expect((await save(await mk(), "2026-05-31T09:00")).statusCode).toBe(200);
  });

  it("accepts an empty value (field left blank)", async () => {
    expect((await save(await mk(), "")).statusCode).toBe(200);
  });
});
