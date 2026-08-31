import { AppError, createDeliveryKey, getAccessContext, listDeliveryKeys } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, login, setupApi } from "./helpers.js";

/**
 * Every other delivery-key write (list/rename/revoke) takes the AccessContext and
 * checks `deliverykey.manage` itself. createDeliveryKey took a raw `siteId` and
 * trusted its callers to gate — the one write in the query layer whose safety
 * depended on the route above it (the MCP tool carried its own `need(...)`).
 */
describe("createDeliveryKey enforces deliverykey.manage in the query layer", () => {
  let s: Suite;
  const userId = async (email: string): Promise<string> => {
    const admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const users = (await s.app.inject({ method: "GET", url: "/api/v1/manage/users", headers: { cookie: admin.cookie } })).json() as Array<{ id: string; email: string }>;
    return users.find((u) => u.email === email)!.id;
  };

  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("an Editor ctx (no deliverykey.manage) is refused with 403 by the db function itself", async () => {
    const ctx = { ...(await getAccessContext(s.app.db, await userId("editor@paperboy.test"))), via: "web" as const };
    expect(ctx.permissions).not.toContain("deliverykey.manage");
    const attempt = createDeliveryKey(s.app.db, ctx, "editor-minted", "public");
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({ status: 403 });
  });

  it("an Admin ctx mints a key scoped to the ctx's active site", async () => {
    const ctx = { ...(await getAccessContext(s.app.db, await userId("admin@paperboy.test"))), via: "web" as const };
    const { key } = await createDeliveryKey(s.app.db, ctx, "admin-minted", "preview");
    expect(key).toMatch(/^prv_/);
    const listed = await listDeliveryKeys(s.app.db, ctx);
    expect(listed.some((k) => k.name === "admin-minted" && k.type === "preview")).toBe(true);
  });
});
