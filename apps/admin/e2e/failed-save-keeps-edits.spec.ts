import { type Page, expect, test } from "@playwright/test";

/**
 * Audit 2026-11-10: a failed autosave (network error, 500, a colleague's 409)
 * left the editor in the "error" state with the edits no longer marked
 * pending, and every guard asked only "dirty or saving?". So Publish skipped
 * the save and published the OLDER server draft, then put that text on screen;
 * leaving the page neither saved nor warned. The edits were simply gone.
 */

async function draftPage(page: Page, name: string): Promise<string> {
  const login = await page.request.post("/api/v1/auth/login", { data: { email: "editor@paperboy.test", password: "Editor!Passw0rd" } });
  expect(login.ok()).toBe(true);
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const created = await page.request.post("/api/v1/manage/content", {
    headers: { "x-csrf-token": csrfToken, origin: "http://localhost:8090" },
    data: { type: "ArticlePage", locale: "en", name: `${name} ${Date.now().toString().slice(-6)}`, data: { heading: "start" } },
  });
  expect(created.ok(), await created.text()).toBe(true);
  return ((await created.json()) as { documentId: string }).documentId;
}

/** Fail the FIRST save of this page at the network level; let later ones through. */
async function failFirstSave(page: Page, documentId: string): Promise<() => number> {
  let puts = 0;
  await page.route(`**/api/v1/manage/content/${documentId}?locale=en`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    puts++;
    return puts === 1 ? route.abort("failed") : route.continue();
  });
  return () => puts;
}

const serverDraft = async (page: Page, documentId: string) =>
  (await (await page.request.get(`/api/v1/manage/content/${documentId}?locale=en`)).json()) as { status: string; data: { heading?: string } };

test("Publish after a failed save publishes what is on screen, not the older draft", async ({ page }) => {
  const documentId = await draftPage(page, "Failed save then publish");
  const puts = await failFirstSave(page, documentId);

  await page.goto(`/edit/${documentId}`);
  const heading = page.locator("#f-heading");
  await expect(heading).toHaveValue("start", { timeout: 15_000 });
  await heading.fill("typed before the network dropped");
  await expect.poll(puts, { timeout: 5_000 }).toBe(1);
  await expect(page.getByText("Couldn’t save").first()).toBeVisible();

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect.poll(async () => (await serverDraft(page, documentId)).status, { timeout: 10_000 }).toBe("published");
  expect((await serverDraft(page, documentId)).data.heading).toBe("typed before the network dropped");
  await expect(heading).toHaveValue("typed before the network dropped");
});

test("leaving the page after a failed save still saves the edits", async ({ page }) => {
  const documentId = await draftPage(page, "Failed save then leave");
  const puts = await failFirstSave(page, documentId);

  await page.goto(`/edit/${documentId}`);
  const heading = page.locator("#f-heading");
  await expect(heading).toHaveValue("start", { timeout: 15_000 });
  await heading.fill("typed before leaving");
  await expect.poll(puts, { timeout: 5_000 }).toBe(1);
  await expect(page.getByText("Couldn’t save").first()).toBeVisible();

  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect.poll(async () => (await serverDraft(page, documentId)).data.heading, { timeout: 8_000 }).toBe("typed before leaving");
});

test("after a conflict, taking their version and leaving keeps their version", async ({ page, browser, baseURL }) => {
  const documentId = await draftPage(page, "Conflict then reload");
  await page.goto(`/edit/${documentId}`);
  const heading = page.locator("#f-heading");
  await expect(heading).toHaveValue("start", { timeout: 15_000 });

  // A colleague saves first (their own session), so our next save is a 409.
  const theirs = await browser.newContext({ baseURL });
  const login = await theirs.request.post("/api/v1/auth/login", { data: { email: "admin@paperboy.test", password: "Admin!Passw0rd" } });
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const saved = await theirs.request.put(`/api/v1/manage/content/${documentId}?locale=en`, {
    headers: { "x-csrf-token": csrfToken, origin: "http://localhost:8090" },
    data: { merge: true, data: { heading: "their version" } },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  await theirs.close();

  await heading.fill("mine, refused");
  await expect(page.getByText("Someone else changed this page while you were editing.")).toBeVisible({ timeout: 8_000 });
  await page.getByRole("button", { name: "Reload their version" }).click();
  await expect(heading).toHaveValue("their version");

  await page.getByRole("link", { name: "Dashboard" }).click();
  await page.waitForTimeout(2500); // any leave-page save would have landed by now
  expect((await serverDraft(page, documentId)).data.heading).toBe("their version");
});

test("Ctrl+S after a failed save tries again", async ({ page }) => {
  const documentId = await draftPage(page, "Failed save then retry");
  const puts = await failFirstSave(page, documentId);

  await page.goto(`/edit/${documentId}`);
  const heading = page.locator("#f-heading");
  await expect(heading).toHaveValue("start", { timeout: 15_000 });
  await heading.fill("saved on the second try");
  await expect.poll(puts, { timeout: 5_000 }).toBe(1);
  await expect(page.getByText("Couldn’t save").first()).toBeVisible();

  await page.keyboard.press("Control+s");
  await expect.poll(async () => (await serverDraft(page, documentId)).data.heading, { timeout: 8_000 }).toBe("saved on the second try");
});
