import { expect, test } from "@playwright/test";
import { SEL, login, uniqueName } from "./helpers.js";

/**
 * CONTENT TYPES — the Settings → Content types editor: build a new BLOCK type
 * with one field of every type plus validation, use it on a page, then prove
 * the delete-while-in-use guard (blocked while used, allowed once usage is
 * removed).
 *
 * Field types offered by the editor: text, richtext, boolean, number, datetime,
 * select, link, image, reference, contentArea.
 */

test.beforeEach(async ({ page }) => {
  await login(page);
});

/** Open Settings → Content types and start a new type. */
async function openNewTypeDialog(page: import("@playwright/test").Page) {
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Content types" }).first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "New content type" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByRole("heading", { name: "New content type" })).toBeVisible();
  return dlg;
}

test("the field-type dropdown offers every supported field type", async ({ page }) => {
  const dlg = await openNewTypeDialog(page);
  await dlg.getByRole("button", { name: "Add field" }).click();
  const typeSelect = dlg.getByLabel("Field type").first();
  for (const t of ["text", "richtext", "boolean", "number", "datetime", "select", "link", "image", "reference", "contentArea"]) {
    await expect(typeSelect.locator(`option[value="${t}"]`)).toHaveCount(1);
  }
  // Choosing "select" reveals the options editor; "contentArea" reveals allowed blocks.
  await typeSelect.selectOption("select");
  await expect(dlg.getByRole("button", { name: "Add option" })).toBeVisible();
  await typeSelect.selectOption("contentArea");
  await expect(dlg.getByText("Allowed blocks")).toBeVisible();
});

test("create a BLOCK type with many field types + maxLength validation", async ({ page }) => {
  const dlg = await openNewTypeDialog(page);
  const code = `DbgBlock${Date.now().toString().slice(-7)}`;
  await dlg.getByLabel("Name (code)").fill(code);
  await dlg.getByLabel("Display name", { exact: true }).fill("Debug Block");
  await dlg.getByLabel("Kind").selectOption("block");

  const specs: Array<{ name: string; type: string }> = [
    { name: "bodyText", type: "text" },
    { name: "bodyRich", type: "richtext" },
    { name: "isFeatured", type: "boolean" },
    { name: "rank", type: "number" },
    { name: "goLive", type: "datetime" },
    { name: "tone", type: "select" },
    { name: "cta", type: "link" },
    { name: "hero", type: "image" },
  ];
  for (const [i, s] of specs.entries()) {
    await dlg.getByRole("button", { name: "Add field" }).click();
    await dlg.getByLabel("Field name").nth(i).fill(s.name);
    await dlg.getByLabel("Field display name").nth(i).fill(s.name);
    await dlg.getByLabel("Field type").nth(i).selectOption(s.type);
  }

  // maxLength validation on the first (text) field — its validation editor.
  await dlg.getByLabel("Maximum length").first().fill("120");
  // Options for the select field.
  const selectRow = dlg.getByLabel("Field type").nth(5).locator("xpath=ancestor::div[contains(@class,'border')][1]");
  await selectRow.getByRole("button", { name: "Add option" }).click();
  await selectRow.getByLabel("Option value").fill("warm");
  await selectRow.getByLabel("Option label").fill("Warm");

  await dlg.getByRole("button", { name: "Create type" }).click();
  await expect(page.getByText("Content type created").first()).toBeVisible({ timeout: 10_000 });
  // It appears in the list (filter to Blocks).
  await page.getByRole("tab", { name: /^Blocks/ }).click();
  await expect(page.getByText(code, { exact: false })).toBeVisible({ timeout: 10_000 });
});

test("delete is blocked while the type is in use, allowed once usage is removed", async ({ page }) => {
  // 1) Create a fresh PAGE type with one text field.
  const dlg = await openNewTypeDialog(page);
  const code = `DbgUsed${Date.now().toString().slice(-7)}`;
  await dlg.getByLabel("Name (code)").fill(code);
  await dlg.getByLabel("Display name", { exact: true }).fill("Debug Used");
  // kind defaults to "page" — keep it so it can be created from the tree.
  await dlg.getByRole("button", { name: "Add field" }).click();
  await dlg.getByLabel("Field name").fill("heading");
  await dlg.getByLabel("Field display name").fill("Heading");
  await dlg.getByRole("button", { name: "Create type" }).click();
  await expect(page.getByText("Content type created").first()).toBeVisible({ timeout: 10_000 });

  // 2) Use it: create a page of this type from the tree.
  await page.getByRole("link", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Create new content" }).click();
  const createDlg = page.getByRole("dialog", { name: "Create content" });
  await createDlg.getByLabel("Content type").selectOption(code);
  const pageName = uniqueName("usedtype");
  await createDlg.getByLabel("Name").fill(pageName);
  await createDlg.getByRole("button", { name: "Create", exact: true }).click();
  await expect(SEL.nameInput(page)).toHaveValue(pageName, { timeout: 15_000 });

  // 3) Back in Settings the type shows in-use and delete is blocked.
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Content types" }).first()).toBeVisible();
  // open the edit dialog for our type
  const typeRow = page.getByText(code, { exact: true }).locator("xpath=ancestor::div[contains(@class,'items-center')][1]");
  await typeRow.getByRole("button", { name: "Edit" }).click();
  const editDlg = page.getByRole("dialog");
  await expect(editDlg.getByText("In use — can’t delete")).toBeVisible({ timeout: 10_000 });
  await editDlg.getByRole("button", { name: "Cancel" }).click();

  // 4) Remove usage: trash the page that uses it, then empty the trash so it's
  //    truly gone (a trashed item still counts as an item).
  await page.getByRole("link", { name: "Edit" }).click();
  await SEL.treeItem(page, pageName).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await expect(page.getByText("Moved to trash").first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Empty trash" }).click();
  await expect(page.getByText(/Trash emptied/).first()).toBeVisible({ timeout: 10_000 });

  // 5) Now delete is allowed: open the type editor and confirm the two-step delete.
  await page.getByRole("button", { name: "Content types", exact: true }).click();
  const typeRow2 = page.getByText(code, { exact: true }).locator("xpath=ancestor::div[contains(@class,'items-center')][1]");
  await typeRow2.getByRole("button", { name: "Edit" }).click();
  const editDlg2 = page.getByRole("dialog");
  await editDlg2.getByRole("button", { name: "Delete type" }).click();
  await editDlg2.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Content type deleted").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(code, { exact: true })).toHaveCount(0, { timeout: 10_000 });
});
