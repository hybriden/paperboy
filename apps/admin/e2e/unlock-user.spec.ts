import { expect, test } from "@playwright/test";

/**
 * A locked account showed a "locked" badge in Users & roles and nothing to do
 * about it: the owner waited out the lock, and anyone who kept guessing kept
 * them out. An every-site Admin can now lift it.
 */
test("an Admin unlocks a locked account from Users & roles", async ({ page, browser, baseURL }) => {
  const EMAIL = "viewer@paperboy.test";
  const guesser = await browser.newContext({ baseURL });
  for (let i = 0; i < 5; i++) await guesser.request.post("/api/v1/auth/login", { data: { email: EMAIL, password: "not-the-password" } });
  expect((await guesser.request.post("/api/v1/auth/login", { data: { email: EMAIL, password: "Viewer!Passw0rd" } })).status(), "locked").toBe(401);

  await page.goto("/");
  await page.getByLabel("Email").fill("admin@paperboy.test");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Password", { exact: true }).fill("Admin!Passw0rd");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation").first()).toBeVisible();
  await page.goto("/settings");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Users & roles", exact: true }).click();

  const row = page.locator("div", { has: page.getByText(EMAIL, { exact: true }) }).filter({ has: page.getByRole("button", { name: "Edit" }) }).last();
  await expect(row.getByText("locked", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: `Unlock ${EMAIL}` }).click();
  await expect(row.getByText("locked", { exact: true })).toHaveCount(0);

  expect((await guesser.request.post("/api/v1/auth/login", { data: { email: EMAIL, password: "Viewer!Passw0rd" } })).status()).toBe(200);
  await guesser.close();
});
