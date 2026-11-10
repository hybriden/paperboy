import { type Page, expect, test } from "@playwright/test";

/**
 * Audit 2026-11-10: the admin left ?lang= off every editor link when the
 * language was "en", but a missing ?lang means the CONFIGURED default. On an
 * instance whose default is Norwegian, editing in English and clicking another
 * page opened it in Norwegian, and "New shared block" always created an
 * English variant, then opened the Norwegian scaffold.
 */

async function asAdmin(page: Page): Promise<Record<string, string>> {
  const login = await page.request.post("/api/v1/auth/login", { data: { email: "admin@paperboy.test", password: "Admin!Passw0rd" } });
  expect(login.ok()).toBe(true);
  return { "x-csrf-token": ((await login.json()) as { csrfToken: string }).csrfToken, origin: "http://localhost:8090" };
}

test.describe("on an instance whose default language is not English", () => {
  test.beforeEach(async ({ page }) => {
    const headers = await asAdmin(page);
    expect((await page.request.patch("/api/v1/manage/locales/nb", { headers, data: { isDefault: true } })).ok()).toBe(true);
  });
  test.afterEach(async ({ page }) => {
    const headers = await asAdmin(page);
    await page.request.patch("/api/v1/manage/locales/en", { headers, data: { isDefault: true } });
  });

  test("clicking another page keeps editing in English", async ({ page }) => {
    const pages = (await (await page.request.get("/api/v1/manage/pages")).json()) as Array<{ documentId: string; name: string }>;
    const home = pages.find((p) => p.name === "Home")!;
    await page.goto(`/edit/${home.documentId}?lang=en`);
    await page.getByRole("treeitem", { name: /Blog/ }).first().click();
    await expect(page).toHaveURL(/\/edit\/[^?]+\?lang=en$/);
  });

  test("a new shared block is created in the language being edited", async ({ page }) => {
    const pages = (await (await page.request.get("/api/v1/manage/pages")).json()) as Array<{ documentId: string; name: string }>;
    const home = pages.find((p) => p.name === "Home")!;
    await page.goto(`/edit/${home.documentId}?lang=nb`);
    await page.getByRole("button", { name: "New shared block" }).click();
    const dialog = page.getByRole("dialog", { name: "New shared block" });
    await dialog.getByLabel("Name").fill(`Locale block ${Date.now().toString().slice(-6)}`);
    const created = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/v1/manage/content"));
    await dialog.getByRole("button", { name: "Create block" }).click();
    const id = ((await (await created).json()) as { documentId: string }).documentId;
    await expect(page).toHaveURL(new RegExp(`/edit/${id}\\?lang=nb$`));
    const versions = (await (await page.request.get(`/api/v1/manage/content/${id}/versions?locale=nb`)).json()) as unknown[];
    expect(versions.length, "the block exists in Norwegian, the language being edited").toBeGreaterThan(0);
  });
});
