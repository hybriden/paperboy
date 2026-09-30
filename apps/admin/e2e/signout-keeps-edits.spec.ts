import { expect, test } from "@playwright/test";

/**
 * Audit 2026-09-30: signing out in ANOTHER tab kills the shared session. This
 * tab's next autosave then gets a 401, the app swaps the editor for the Login
 * screen, and the editor unmounts with its unsaved text — which was gone for
 * good. Signing back in must offer those edits back.
 */
test("edits typed before a sign-out in another tab are offered back after signing in again", async ({ page }) => {
  const creds = { email: "editor@paperboy.test", password: "Editor!Passw0rd" };
  const login = await page.request.post("/api/v1/auth/login", { data: creds });
  expect(login.ok()).toBe(true);
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const created = await page.request.post("/api/v1/manage/content", {
    headers: { "x-csrf-token": csrfToken, origin: "http://localhost:8090" },
    data: { type: "ArticlePage", locale: "en", name: `Signout ${Date.now().toString().slice(-6)}`, data: { heading: "start" } },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { documentId } = (await created.json()) as { documentId: string };

  await page.goto(`/edit/${documentId}`);
  const heading = page.locator("#f-heading");
  await expect(heading).toHaveValue("start", { timeout: 15_000 });

  // "Another tab" signs out (same cookie jar), then this tab types: its
  // autosave hits a dead session.
  const out = await page.request.post("/api/v1/auth/logout", { headers: { "x-csrf-token": csrfToken, origin: "http://localhost:8090" } });
  expect(out.ok(), await out.text()).toBe(true);
  await heading.fill("typed before the sign-out was noticed");

  // The app falls back to the Login screen; sign in again in THIS tab.
  await expect(page.getByLabel("Email")).toBeVisible({ timeout: 10_000 });
  await page.getByLabel("Email").fill(creds.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Password", { exact: true }).fill(creds.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Back on the same page: the lost edit is offered, and restoring saves it.
  await page.getByRole("button", { name: "Restore my changes" }).click();
  await expect(heading).toHaveValue("typed before the sign-out was noticed");
  await expect.poll(async () => {
    const res = await page.request.get(`/api/v1/manage/content/${documentId}?locale=en`);
    return ((await res.json()) as { data: { heading?: string } }).data.heading;
  }, { timeout: 8_000 }).toBe("typed before the sign-out was noticed");
});

test("edits that were saved normally are not offered back", async ({ page }) => {
  const login = await page.request.post("/api/v1/auth/login", { data: { email: "editor@paperboy.test", password: "Editor!Passw0rd" } });
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const created = await page.request.post("/api/v1/manage/content", {
    headers: { "x-csrf-token": csrfToken, origin: "http://localhost:8090" },
    data: { type: "ArticlePage", locale: "en", name: `Saved ${Date.now().toString().slice(-6)}`, data: { heading: "start" } },
  });
  const { documentId } = (await created.json()) as { documentId: string };

  await page.goto(`/edit/${documentId}`);
  const heading = page.locator("#f-heading");
  await expect(heading).toHaveValue("start", { timeout: 15_000 });
  await heading.fill("saved the normal way");
  // Leave straight away (in-app navigation): the leave-page flush saves it.
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect.poll(async () => {
    const res = await page.request.get(`/api/v1/manage/content/${documentId}?locale=en`);
    return ((await res.json()) as { data: { heading?: string } }).data.heading;
  }, { timeout: 8_000 }).toBe("saved the normal way");

  // A full load (same tab, so the same sessionStorage the stash would live in).
  await page.goto(`/edit/${documentId}`);
  await expect(heading).toHaveValue("saved the normal way", { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Restore my changes" })).toHaveCount(0);
});
