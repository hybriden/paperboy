import { expect, test } from "@playwright/test";

/**
 * Audit 2026-09-30: the admin kept the CSRF token it got at load, bound to THAT
 * session row. Signing in again in another tab replaced the shared session
 * cookie, so this tab's GETs kept working while every save sent the old token
 * and got `403 csrf_failed` — autosave failed forever and only a reload (which
 * discards the unsaved edits) recovered. The client must re-read the token for
 * the current session and retry once.
 */
test("a save still lands after the session was renewed in another tab", async ({ page }) => {
  const creds = { email: "editor@paperboy.test", password: "Editor!Passw0rd" };
  const first = await page.request.post("/api/v1/auth/login", { data: creds });
  expect(first.ok()).toBe(true);
  const { csrfToken } = (await first.json()) as { csrfToken: string };
  const created = await page.request.post("/api/v1/manage/content", {
    headers: { "x-csrf-token": csrfToken, origin: "http://localhost:8090" },
    data: { type: "ArticlePage", locale: "en", name: `Csrf ${Date.now().toString().slice(-6)}`, data: { heading: "start" } },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { documentId } = (await created.json()) as { documentId: string };

  await page.goto(`/edit/${documentId}`);
  const heading = page.locator("#f-heading");
  await expect(heading).toHaveValue("start", { timeout: 15_000 });

  // "Another tab" signs in again: same browser cookie jar, new session + token.
  expect((await page.request.post("/api/v1/auth/login", { data: creds })).ok()).toBe(true);

  await heading.fill("after re-login");
  await expect.poll(async () => {
    const res = await page.request.get(`/api/v1/manage/content/${documentId}?locale=en`);
    return ((await res.json()) as { data: { heading?: string } }).data.heading;
  }, { timeout: 8_000 }).toBe("after re-login");
});
