import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, authHeaders, login, setupApi } from "./helpers.js";

describe("AI batch translate (one request per page, not per field)", () => {
  let s: Suite;
  let ed: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    s = await setupApi();
    ed = await login(s.app, "editor@paperboy.test", "Editor!Passw0rd");
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("translates many strings in a single call (offline → copies the source)", async () => {
    const texts = ["Hello", "World", "# A heading", "Some **bold** copy"];
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/ai/translate",
      headers: authHeaders(ed),
      payload: { texts, targetLocale: "nb" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: string[]; provider: string };
    expect(body.provider).toBe("fallback"); // no key in tests
    expect(body.results).toEqual(texts); // offline returns the source unchanged, same order/length
  });

  it("rejects a batch over the total-character cap (S3-L2: bounds model spend)", async () => {
    const texts = Array.from({ length: 30 }, () => "a".repeat(10_000)); // 300,000 chars (under the body limit, over the model-input cap)
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/ai/translate",
      headers: authHeaders(ed),
      payload: { texts, targetLocale: "nb" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("requires content.update (Viewer denied)", async () => {
    const viewer = await login(s.app, "viewer@paperboy.test", "Viewer!Passw0rd");
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/ai/translate",
      headers: authHeaders(viewer),
      payload: { texts: ["x"], targetLocale: "nb" },
    });
    expect(res.statusCode).toBe(403);
  });
});
