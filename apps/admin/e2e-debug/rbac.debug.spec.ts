import { expect, test } from "@playwright/test";
import { CREDENTIALS, SEL, login, openHome } from "./helpers.js";

/**
 * RBAC — role-scoped UI:
 *  - Editor: no Users & MCP settings tabs (lacks user.manage).
 *  - Author (seeded author@paperboy.test, scoped to the "Author Zone" section):
 *    the tree shows only that section; a deep-link to out-of-scope content is
 *    denied.
 *  - Viewer: read-only editor — no Create button, disabled fields, no Publish.
 *
 * Uses the seeded author@ / viewer@ accounts (see seed.ts).
 */

test("Editor cannot see the Users & MCP settings tabs", async ({ page }) => {
  await login(page, CREDENTIALS.editor.email, CREDENTIALS.editor.password);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  // Content-model tabs are visible…
  await expect(page.getByRole("button", { name: "Content types", exact: true })).toBeVisible();
  // …but the user-management tabs (gated on user.manage) are not.
  await expect(page.getByRole("button", { name: "Users & roles", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "MCP", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "AI", exact: true })).toHaveCount(0);
});

test("Editor cannot manage content types (no New content type button)", async ({ page }) => {
  await login(page, CREDENTIALS.editor.email, CREDENTIALS.editor.password);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Content types" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "New content type" })).toHaveCount(0);
});

test("Author is scoped: tree shows only the Author Zone section", async ({ page }) => {
  await login(page, CREDENTIALS.author.email, CREDENTIALS.author.password);
  // The Author is scoped to "Author Zone" — its tree shows that root and not
  // the other top-level pages (Home, Blog).
  await expect(SEL.treeItem(page, "Author Zone").first()).toBeVisible({ timeout: 15_000 });
  await expect(SEL.treeItem(page, /^Home$/)).toHaveCount(0);
  await expect(SEL.treeItem(page, /^Blog$/)).toHaveCount(0);
});

test("Author deep-link to out-of-scope content (Home) is denied", async ({ page }) => {
  // Discover Home's id as an Admin (API), then visit it as the Author.
  const admin = await page.request.post("/api/v1/auth/login", {
    data: { email: CREDENTIALS.admin.email, password: CREDENTIALS.admin.password },
  });
  expect(admin.ok()).toBeTruthy();
  const adminCookie = admin
    .headersArray()
    .find((h) => h.name.toLowerCase() === "set-cookie" && h.value.includes("paperboy_sid"))!
    .value.split(";")[0]!;
  const tree = await page.request.get("/api/v1/manage/content/tree", { headers: { cookie: adminCookie } });
  const nodes = (await tree.json()) as Array<{ documentId: string; name: string }>;
  const home = nodes.find((n) => n.name === "Home");
  expect(home, "Home should exist in the seed").toBeTruthy();

  // Now act as the Author and deep-link to Home (out of scope).
  await login(page, CREDENTIALS.author.email, CREDENTIALS.author.password);
  await page.goto(`/edit/${home!.documentId}`);
  // The editor surfaces an access-denied message rather than the content.
  await expect(page.getByText(/don.t have access|Failed to load/i)).toBeVisible({ timeout: 15_000 });
  // And the name field never loads with "Home".
  await expect(page.getByRole("textbox", { name: "Name", exact: true }).and(page.locator("[aria-label='Name']"))).toHaveCount(0);
});

test("Viewer gets a read-only editor: no Create, disabled fields, no Publish", async ({ page }) => {
  await login(page, CREDENTIALS.viewer.email, CREDENTIALS.viewer.password);
  // No "Create new content" affordance (lacks content.create).
  await expect(page.getByRole("button", { name: "Create new content" })).toHaveCount(0);

  // Open a seeded page; its fields are disabled and there's no Publish button.
  await openHome(page);
  await expect(SEL.nameInput(page)).toBeDisabled();
  await expect(page.locator("#f-heading")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toHaveCount(0);
});
