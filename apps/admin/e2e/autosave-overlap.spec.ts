import { expect, test } from "@playwright/test";

/**
 * Audit 2026-09-30: autosaves were not serialized. Each save sent the revision
 * the form held, which only advanced in the previous save's onSuccess — so a
 * save issued while another was still in flight carried the OLD revision and
 * the server refused it with 409 against the editor's own earlier save. On a
 * slow request the editor saw "Someone else changed this page" and had to
 * reload, losing what they typed after the first save.
 */
test("a save issued while the previous one is in flight does not conflict with it", async ({ page }) => {
  const login = await page.request.post("/api/v1/auth/login", {
    data: { email: "editor@paperboy.test", password: "Editor!Passw0rd" },
  });
  expect(login.ok()).toBe(true);
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const created = await page.request.post("/api/v1/manage/content", {
    headers: { "x-csrf-token": csrfToken, origin: "http://localhost:8090" },
    data: { type: "ArticlePage", locale: "en", name: `Overlap ${Date.now().toString().slice(-6)}`, data: { heading: "start" } },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { documentId } = (await created.json()) as { documentId: string };

  // Hold the FIRST autosave's response for 3s so the second save is issued
  // while it is still in flight — a slow network, deterministically.
  let puts = 0;
  await page.route(`**/api/v1/manage/content/${documentId}?locale=en`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    puts++;
    if (puts === 1) {
      const response = await route.fetch();
      await new Promise((r) => setTimeout(r, 3000));
      return route.fulfill({ response });
    }
    return route.continue();
  });

  await page.goto(`/edit/${documentId}`);
  const heading = page.locator("#f-heading");
  await expect(heading).toHaveValue("start", { timeout: 15_000 });

  await heading.fill("first edit");
  await expect.poll(() => puts, { timeout: 5_000 }).toBe(1); // save A in flight
  await heading.fill("second edit"); // save B debounces while A is held
  await page.waitForTimeout(4500);

  await expect(page.getByText("Someone else changed this page", { exact: false })).toHaveCount(0);
  await expect.poll(async () => {
    const res = await page.request.get(`/api/v1/manage/content/${documentId}?locale=en`);
    return ((await res.json()) as { data: { heading?: string } }).data.heading;
  }, { timeout: 5_000 }).toBe("second edit");
});

/**
 * Audit 2026-09-30 follow-up: the leave-page save updated the server but not
 * the admin's cached copy of the page. Coming straight back (in-app) re-seeded
 * the editor from that stale copy — the old text on screen, and the old
 * revision, so the next edit was refused as "someone else changed this page".
 */
test("coming back after the leave-page save shows the saved text and keeps saving", async ({ page }) => {
  const login = await page.request.post("/api/v1/auth/login", { data: { email: "editor@paperboy.test", password: "Editor!Passw0rd" } });
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const created = await page.request.post("/api/v1/manage/content", {
    headers: { "x-csrf-token": csrfToken, origin: "http://localhost:8090" },
    data: { type: "ArticlePage", locale: "en", name: `Return ${Date.now().toString().slice(-6)}`, data: { heading: "start" } },
  });
  const { documentId } = (await created.json()) as { documentId: string };
  const serverHeading = async () =>
    ((await (await page.request.get(`/api/v1/manage/content/${documentId}?locale=en`)).json()) as { data: { heading?: string } }).data.heading;

  await page.goto(`/edit/${documentId}`);
  const heading = page.locator("#f-heading");
  await expect(heading).toHaveValue("start", { timeout: 15_000 });
  await heading.fill("saved on the way out");
  await page.getByRole("link", { name: "Dashboard" }).click(); // leave before the debounce fires
  await expect.poll(serverHeading, { timeout: 8_000 }).toBe("saved on the way out");

  await page.goBack(); // in-app: same SPA, same query cache
  await expect(heading).toHaveValue("saved on the way out", { timeout: 15_000 });
  await heading.fill("edited after coming back");
  await expect.poll(serverHeading, { timeout: 8_000 }).toBe("edited after coming back");
  await expect(page.getByText("Someone else changed this page", { exact: false })).toHaveCount(0);
});
