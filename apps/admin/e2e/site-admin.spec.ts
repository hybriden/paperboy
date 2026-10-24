import { randomBytes } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";

/**
 * A ONE-SITE Admin (#130): an every-site Admin gives someone Admin in one site;
 * signed in, they run that site's users and settings but never reach the
 * instance tabs (sites, AI, agent access, type templates) nor delete accounts.
 */

const run = randomBytes(3).toString("hex");
const SITE = `E2E Brand ${run}`;
const SITE_ADMIN = { email: `site-admin-${run}@paperboy.test`, password: "SiteAdmin!Passw0rd" };

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

const settingsNav = (page: Page) => page.getByRole("navigation", { name: "Settings sections" });

test.beforeAll(async ({ request, baseURL }) => {
  const login = await request.post("/api/v1/auth/login", { data: { email: "admin@paperboy.test", password: "Admin!Passw0rd" } });
  expect(login.status(), await login.text()).toBe(200);
  const headers = { "x-csrf-token": ((await login.json()) as { csrfToken: string }).csrfToken, origin: baseURL! };
  const site = await request.post("/api/v1/manage/sites", { headers, data: { slug: `e2e-${run}`, name: SITE, defaultLocale: "en" } });
  expect(site.status(), await site.text()).toBe(200);
  const siteId = ((await site.json()) as { id: string }).id;
  const user = await request.post("/api/v1/manage/users", {
    headers,
    data: { email: SITE_ADMIN.email, name: "Site Admin", password: SITE_ADMIN.password, roles: [], siteRoles: [{ siteId, role: "Admin" }] },
  });
  expect(user.status(), await user.text()).toBe(200);
});

test("an every-site Admin sees the one-site role on the user", async ({ page }) => {
  await signIn(page, "admin@paperboy.test", "Admin!Passw0rd");
  await page.getByRole("link", { name: "Settings" }).click();
  await settingsNav(page).getByRole("button", { name: "Users & roles", exact: true }).click();
  const row = page.locator("div").filter({ hasText: SITE_ADMIN.email }).last();
  await expect(row.getByText(`Admin · ${SITE}`)).toBeVisible();
  await row.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("group", { name: `Roles in ${SITE}` }).getByRole("button", { name: "Admin" })).toHaveAttribute("aria-pressed", "true");
});

test("a one-site Admin runs their site's users but never the instance", async ({ page }) => {
  await signIn(page, SITE_ADMIN.email, SITE_ADMIN.password);
  await page.getByRole("link", { name: "Settings" }).click();
  const nav = settingsNav(page);
  await expect(nav).toBeVisible();
  for (const tab of ["General", "Delivery keys", "Webhooks", "Users & roles", "Audit log"]) await expect(nav.getByRole("button", { name: tab, exact: true })).toBeVisible();
  for (const tab of ["Sites", "Agent access", "AI provider", "Stock images", "Type templates"]) await expect(nav.getByRole("button", { name: tab, exact: true })).toHaveCount(0);

  await nav.getByRole("button", { name: "Users & roles", exact: true }).click();
  await expect(page.getByText(`The people who work in ${SITE}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

  // A brand-new account, Editor in this site.
  const editor = `site-editor-${run}@paperboy.test`;
  await page.getByRole("button", { name: "Add user" }).click();
  let dlg = page.getByRole("dialog", { name: `Add a user to ${SITE}` });
  await dlg.getByLabel("Email").fill(editor);
  await dlg.getByLabel("Name").fill("Site Editor");
  await dlg.getByLabel("Temporary password").fill("SiteEditor!Passw0rd");
  await dlg.getByRole("group", { name: `Roles in ${SITE}` }).getByRole("button", { name: "Author" }).click(); // off (the default)
  await dlg.getByRole("group", { name: `Roles in ${SITE}` }).getByRole("button", { name: "Editor" }).click();
  await dlg.getByRole("button", { name: "Add user" }).click();
  await expect(page.getByText(editor)).toBeVisible();

  // An existing account is added by email alone; its account fields stay locked.
  await page.getByRole("button", { name: "Add user" }).click();
  dlg = page.getByRole("dialog", { name: `Add a user to ${SITE}` });
  await dlg.getByLabel("Email").fill("viewer@paperboy.test");
  await dlg.getByLabel("Name").fill("ignored");
  await dlg.getByRole("button", { name: "Add user" }).click();
  await expect(page.getByText("viewer@paperboy.test")).toBeVisible();
  await page.locator("div").filter({ hasText: "viewer@paperboy.test" }).last().getByRole("button", { name: "Edit" }).click();
  dlg = page.getByRole("dialog", { name: "Edit viewer@paperboy.test" });
  await expect(dlg.getByLabel("Email")).toBeDisabled();
  await expect(dlg.getByLabel("Name")).toBeDisabled();
  await dlg.getByRole("button", { name: "Cancel" }).click();

  // Their audit log holds what they did here.
  await nav.getByRole("button", { name: "Audit log", exact: true }).click();
  await expect(page.getByText("user.create").first()).toBeVisible();
});
