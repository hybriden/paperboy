import { expect, test, type Page } from "@playwright/test";
import { gotoSettings, login, uniqueName } from "./helpers.js";

/**
 * SETTINGS — every admin panel an Admin can reach:
 * Languages (add/disable/delete), Site preview URL, AI key (save/clear status),
 * Stock images (unconfigured status), Delivery keys (create/rename/revoke),
 * MCP tokens (create shows once / revoke), Webhooks (create/delete), Users
 * (create/edit roles/delete), Audit log (rows + filter by action).
 *
 * Each test scopes its assertions to content IT created (unique names).
 */

test.beforeEach(async ({ page }) => {
  await login(page);
});

/** A settings row (the flex items-center div) that contains the given text. */
function settingsRow(page: Page, text: string | RegExp) {
  return page
    .getByText(text, { exact: typeof text === "string" })
    .locator("xpath=ancestor::div[contains(@class,'items-center')][1]");
}

test("Languages: add, disable, then delete a locale", async ({ page }) => {
  await gotoSettings(page, "Languages");
  // A locale code must match /^[a-z]{2,3}(-…)*$/ AND be unique (not en/nb or a
  // prior run's). Build 3 random lowercase letters, starting with z to dodge
  // real ISO codes.
  const letter = () => String.fromCharCode(97 + Math.floor(Math.random() * 26));
  const code = `z${letter()}${letter()}`;
  await page.getByLabel("Language code").fill(code);
  await page.getByLabel("Display name", { exact: true }).fill(`Debug ${code}`);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Language added").first()).toBeVisible({ timeout: 10_000 });
  const row = settingsRow(page, code);
  await expect(row).toBeVisible();

  // Disable it.
  await row.getByRole("button", { name: "Disable" }).click();
  await expect(page.getByText("Language updated").first()).toBeVisible({ timeout: 10_000 });
  await expect(settingsRow(page, code).getByText("disabled")).toBeVisible();

  // Delete it (confirm() prompt).
  page.once("dialog", (d) => d.accept());
  await settingsRow(page, code).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Language deleted").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(code, { exact: true })).toHaveCount(0, { timeout: 10_000 });
});

test("Site: save the preview base URL", async ({ page }) => {
  await gotoSettings(page, "Site");
  const url = "http://localhost:8092";
  const input = page.getByRole("textbox", { name: /Preview base URL/ }).or(page.locator('input[type="url"]'));
  await input.first().fill(url);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Preview URL saved").first()).toBeVisible({ timeout: 10_000 });
});

test("AI: save a key, see configured status, then clear it back to basic mode", async ({ page }) => {
  await gotoSettings(page, "AI");
  // No key in this env → basic mode status.
  await expect(page.getByText(/basic .*mode|No key configured/i).first()).toBeVisible({ timeout: 10_000 });

  await page.getByRole("textbox", { name: /Anthropic API key/ }).or(page.locator('input[type="password"]').first()).first().fill("sk-ant-debug-fake-key-0000");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("AI settings saved").first()).toBeVisible({ timeout: 10_000 });
  // Status line now shows a configured key (ending ••).
  await expect(page.getByText(/Key configured in the CMS/i)).toBeVisible({ timeout: 10_000 });

  // Clear it.
  await page.getByRole("button", { name: "Clear key" }).click();
  await expect(page.getByText("Key cleared").first()).toBeVisible({ timeout: 10_000 });
});

test("Stock images: panel reports unconfigured status", async ({ page }) => {
  await gotoSettings(page, "Stock images");
  await expect(page.getByText(/No key configured|disabled/i).first()).toBeVisible({ timeout: 10_000 });
  // The provider is Unsplash (the only configured provider option).
  await expect(page.getByRole("combobox")).toHaveValue("unsplash");
});

test("Delivery keys: create (secret shown once), rename, revoke", async ({ page }) => {
  await gotoSettings(page, "API keys");
  const name = uniqueName("dk");
  await page.getByLabel("Key name").fill(name);
  await page.getByLabel("Key type").selectOption("public");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  // The one-time secret banner appears.
  await expect(page.getByText(/won.t be shown again/i)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Dismiss" }).click();

  const row = settingsRow(page, name);
  await expect(row).toBeVisible({ timeout: 10_000 });
  // Rename it.
  await row.getByRole("button", { name: `Rename ${name}` }).click();
  const renamed = `${name}-renamed`;
  await page.getByLabel("Key name").last().fill(renamed);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Key renamed").first()).toBeVisible({ timeout: 10_000 });

  // Revoke it (confirm()).
  page.once("dialog", (d) => d.accept());
  await settingsRow(page, renamed).getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("Key revoked").first()).toBeVisible({ timeout: 10_000 });
  await expect(settingsRow(page, renamed).getByText("revoked")).toBeVisible({ timeout: 10_000 });
});

test("MCP tokens: create (token shown once), then revoke", async ({ page }) => {
  await gotoSettings(page, "MCP");
  const name = uniqueName("mcp");
  await page.getByLabel("Token name").fill(name);
  // "Acts as user" defaults to the first user — fine.
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText(/won.t be shown again/i)).toBeVisible({ timeout: 10_000 });
  // The token value is rendered once in a code block.
  await expect(page.locator("code").filter({ hasText: /mcp_/ }).first()).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();

  page.once("dialog", (d) => d.accept());
  await settingsRow(page, name).getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("Token revoked").first()).toBeVisible({ timeout: 10_000 });
});

test("Webhooks: create then delete", async ({ page }) => {
  await gotoSettings(page, "Webhooks");
  const name = uniqueName("hook");
  await page.getByLabel("Webhook name").fill(name);
  await page.getByLabel("Webhook URL").fill("https://example.com/debug-hook");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  // Signing secret shown once.
  await expect(page.getByText(/Signing secret/i)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(settingsRow(page, name)).toBeVisible({ timeout: 10_000 });

  page.once("dialog", (d) => d.accept());
  await settingsRow(page, name).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Webhook removed").first()).toBeVisible({ timeout: 10_000 });
});

test("Users: create with a role, edit roles, then delete", async ({ page }) => {
  await gotoSettings(page, "Users & roles");
  const email = `dbg-${Date.now().toString(36)}@paperboy.test`;

  await page.getByRole("button", { name: "New user" }).click();
  const dlg = page.getByRole("dialog", { name: "New user" });
  await dlg.getByLabel("Email").fill(email);
  await dlg.getByLabel("Name").fill("Debug User");
  await dlg.getByLabel(/Temporary password/).fill("DebugPassw0rd!");
  // Default role is Author; switch to Editor.
  await dlg.getByRole("button", { name: "Editor" }).click();
  await dlg.getByRole("button", { name: "Author" }).click(); // turn Author off
  await dlg.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByText("User created").first()).toBeVisible({ timeout: 10_000 });
  await expect(settingsRow(page, email)).toBeVisible({ timeout: 10_000 });

  // Edit: add the Viewer role.
  await settingsRow(page, email).getByRole("button", { name: "Edit" }).click();
  const editDlg = page.getByRole("dialog", { name: new RegExp(`Edit ${email.replace(/[.+]/g, "\\$&")}`) });
  await editDlg.getByRole("button", { name: "Viewer" }).click();
  await editDlg.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("User updated").first()).toBeVisible({ timeout: 10_000 });

  // Delete (confirm()).
  page.once("dialog", (d) => d.accept());
  await settingsRow(page, email).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("User deleted").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(email, { exact: true })).toHaveCount(0, { timeout: 10_000 });
});

test("Audit log: renders rows and filters by action", async ({ page }) => {
  await gotoSettings(page, "Audit log");
  // The seed + earlier tests have produced audit entries.
  const rows = page.locator("div").filter({ hasText: /^content\.|^auth\.|^user\.|^locale\./ });
  await expect.poll(async () => page.getByText(/by Site Admin|by /).count(), { timeout: 10_000 }).toBeGreaterThan(0);

  // Filter by the "content" action category.
  await page.getByLabel("Filter by action").selectOption("content.");
  // Every visible action pill should start with "content.".
  await expect.poll(async () => {
    const pills = await page.locator("span.bg-line\\/70").allInnerTexts();
    const actions = pills.filter((t) => t.includes("."));
    return actions.length > 0 && actions.every((t) => t.startsWith("content."));
  }, { timeout: 10_000 }).toBeTruthy();
  void rows;
});
