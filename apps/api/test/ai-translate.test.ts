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

  it("REFUSES with ai_unavailable when no key is configured (never echoes the source as a result)", async () => {
    // The old behaviour returned the untranslated source with provider:"fallback"
    // and a 200 — the exact garbage-in-success-out the module header says was
    // removed for aiAssist. translate is a model-requiring task, so with no key it
    // must refuse like every other one, not hand back the input dressed as output.
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/ai/translate",
      headers: authHeaders(ed),
      payload: { texts: ["Hello", "World"], targetLocale: "nb" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("ai_unavailable");
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
