import { expect, test } from "@playwright/test";

/**
 * Audit 2026-11-10: the rich-text editor read its value once, at mount. When
 * the form was re-seeded from the server ("Reload their version", Discard,
 * Restore version, Translate) every plain field showed the new text but the
 * rich-text body kept the old one, and the next keystroke saved that old body
 * over the version the editor had just chosen.
 */
const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

test("Reload their version shows their rich text too, and typing keeps it", async ({ page, browser, baseURL }) => {
  const login = await page.request.post("/api/v1/auth/login", { data: { email: "editor@paperboy.test", password: "Editor!Passw0rd" } });
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const created = await page.request.post("/api/v1/manage/content", {
    headers: { "x-csrf-token": csrfToken, origin: "http://localhost:8090" },
    data: { type: "ArticlePage", locale: "en", name: `Reseed ${Date.now().toString().slice(-6)}`, data: { heading: "start", intro: doc("my old intro") } },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { documentId } = (await created.json()) as { documentId: string };

  await page.goto(`/edit/${documentId}`);
  const heading = page.locator("#f-heading");
  const intro = page.getByRole("textbox", { name: "Intro" });
  await expect(heading).toHaveValue("start", { timeout: 15_000 });
  await expect(intro).toHaveText("my old intro");

  // A colleague rewrites the intro, then our next save is refused.
  const theirs = await browser.newContext({ baseURL });
  const other = await theirs.request.post("/api/v1/auth/login", { data: { email: "admin@paperboy.test", password: "Admin!Passw0rd" } });
  const saved = await theirs.request.put(`/api/v1/manage/content/${documentId}?locale=en`, {
    headers: { "x-csrf-token": ((await other.json()) as { csrfToken: string }).csrfToken, origin: "http://localhost:8090" },
    data: { merge: true, data: { intro: doc("their new intro") } },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  await theirs.close();

  await heading.fill("mine");
  await expect(page.getByText("Someone else changed this page while you were editing.")).toBeVisible({ timeout: 8_000 });
  await page.getByRole("button", { name: "Reload their version" }).click();
  await expect(intro).toHaveText("their new intro");

  await intro.click();
  await page.keyboard.press("End");
  await page.keyboard.type(", edited");
  await expect.poll(async () => {
    const res = await page.request.get(`/api/v1/manage/content/${documentId}?locale=en`);
    return JSON.stringify(((await res.json()) as { data: { intro?: unknown } }).data.intro);
  }, { timeout: 8_000 }).toContain("their new intro, edited");
});
