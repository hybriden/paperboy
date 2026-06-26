import { type AccessContext, createContent, getAccessContext, updateContent } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, type Suite, login, setupApi } from "./helpers.js";

/**
 * S2-M4: resolveContent expanded references / shared contentArea blocks with only a
 * depth counter and no per-request node budget, so a wide graph could fan out into a
 * resource-DoS (O(B^depth) distinct resolves, each with SEO compute). A per-request
 * budget now caps total resolved nodes; past the cap, nested refs come back shallow
 * ({documentId, type}) instead of recursing.
 */
describe("delivery resolve graph has a per-request node budget", () => {
  let s: Suite;
  let ctx: AccessContext;
  let parentId: string;

  beforeAll(async () => {
    s = await setupApi();
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const users = (await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: { cookie: admin.cookie } })).json() as Array<{ id: string; email: string }>;
    ctx = await getAccessContext(s.app.db, users.find((u) => u.email === "admin@paperboy.test")!.id);

    const blockId = (await createContent(s.app.db, ctx, { type: "CardBlock", locale: "en", name: "Shared Card", parentId: null })).documentId;
    parentId = (await createContent(s.app.db, ctx, { type: "ArticlePage", locale: "en", name: "Fanout", parentId: null })).documentId;
    // 600 shared-block references — far past the resolve budget.
    const mainArea = Array.from({ length: 600 }, (_, i) => ({ key: `b${i}`, blockType: "CardBlock", display: "full", ref: blockId, inline: null }));
    await updateContent(s.app.db, ctx, parentId, "en", { data: { heading: "Fanout", mainArea } });
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("caps deep expansion — late blocks resolve shallow, not recursively", async () => {
    const res = await s.app.inject({ method: "GET", url: `/api/v1/delivery/content/${parentId}?locale=en&populate=4`, headers: { authorization: `Bearer ${PREVIEW_KEY}` } });
    expect(res.statusCode).toBe(200);
    const area = res.json().data.mainArea as Array<{ content?: { data?: unknown; documentId?: string } }>;
    expect(area.length).toBe(600);
    expect(area[0]!.content?.data).toBeDefined(); // early blocks fully resolved
    expect(area[599]!.content?.data).toBeUndefined(); // past the budget → shallow
    expect(area[599]!.content?.documentId).toBeTruthy(); // still a usable ref
  });
});
