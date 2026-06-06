import { expect, test } from "@playwright/test";
import { SEL, createPage, login, openContentActions, openHome, openPublishMenu, trashFromTree, uniqueName, waitForSaved } from "./helpers.js";

/**
 * CONTENT LIFECYCLE — the full editorial workflow on a BlogPost created under
 * the seeded Blog list page: edit every field type the type offers, autosave,
 * publish/unpublish, schedule, discard, duplicate, trash+restore, and version
 * history (make versions, restore an old one, compare A↔B).
 *
 * BlogPost fields: title(text), publishDate(datetime), summary(text,max400),
 * author(text), body(markdown) + the shared SEO group.
 */

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("create a BlogPost under Blog and edit every offered field type", async ({ page }) => {
  // Create as a child of the seeded Blog page via its context menu.
  await SEL.treeItem(page, "Blog").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: /New child page/ }).click();
  const dlg = page.getByRole("dialog", { name: "Create content" });
  await dlg.getByLabel("Content type").selectOption("BlogPost");
  const name = uniqueName("post");
  await dlg.getByLabel("Name").fill(name);
  await dlg.getByRole("button", { name: "Create", exact: true }).click();
  await expect(SEL.nameInput(page)).toHaveValue(name, { timeout: 15_000 });

  // Content group fields.
  await page.getByRole("textbox", { name: /^Title/ }).fill("Lifecycle title");
  await page.locator("#f-publishDate").fill("2026-07-01T09:30");
  await page.getByRole("textbox", { name: /^Summary/ }).fill("A short summary for the lifecycle test.");
  await page.locator("#f-author").fill("Debug Author");
  // markdown body
  await page.locator("#f-body").fill("## Heading\n\nBody **text** for the lifecycle test.");
  await waitForSaved(page);

  // The summary text field exposes a maxLength counter (400).
  await expect(page.getByText(/\/ 400$/)).toBeVisible();

  // SEO group: switch tab, fill meta + toggle noindex (boolean) + select ogType.
  await page.getByRole("tab", { name: "SEO" }).click();
  await page.getByLabel("Meta title").fill("SEO title");
  await page.getByLabel("Meta description").fill("SEO description");
  await waitForSaved(page);
  await page.locator("#f-ogType").selectOption("article");
  await waitForSaved(page);

  // The boolean checkbox is touched LAST, on a fully quiescent form: a pending
  // text-field autosave re-renders the controlled <input> and can revert an
  // in-flight click, so we reload to guarantee no debounced save is mid-flight,
  // then toggle once.
  await page.reload();
  await page.getByRole("tab", { name: "SEO" }).click();
  const noIndex = page.locator("#f-noIndex");
  await expect(noIndex).not.toBeChecked();
  await noIndex.check();
  await expect(noIndex).toBeChecked();
  await waitForSaved(page);

  // Reload and confirm persistence of a representative subset.
  await page.reload();
  await expect(SEL.nameInput(page)).toHaveValue(name);
  await expect(page.getByRole("textbox", { name: /^Title/ })).toHaveValue("Lifecycle title");
  await page.getByRole("tab", { name: "SEO" }).click();
  await expect(page.getByLabel("Meta title")).toHaveValue("SEO title");
  await expect(page.locator("#f-noIndex")).toBeChecked();

  await trashFromTree(page, name);
});

test("autosave indicator transitions dirty → saving → saved", async ({ page }) => {
  await openHome(page);

  // #f-heading targets the page's own Heading (not the H2/H3 toolbar buttons or
  // the seeded ListBlock's nested heading, which also expose the name "Heading").
  await page.locator("#f-heading").fill(`Welcome ${Date.now().toString().slice(-4)}`);
  // Right after typing it's dirty…
  await expect(SEL.saveIndicator(page)).toHaveText(/Unsaved changes/, { timeout: 2000 });
  // …then it settles to saved.
  await expect(SEL.saveIndicator(page)).toHaveText(/All changes saved/, { timeout: 15_000 });

  // Restore the seeded heading so the shared Home page stays canonical for
  // other specs (e.g. the preview tests).
  await page.locator("#f-heading").fill("Welcome to Paperboy");
  await waitForSaved(page);
});

test("publish flips the status chip, then unpublish reverts it", async ({ page }) => {
  const name = await createPage(page, { area: "lifecycle", type: "ArticlePage" });
  await page.getByRole("textbox", { name: /Heading/ }).fill("Publishable heading");
  await waitForSaved(page);

  await SEL.publishBtn(page).click();
  await expect(page.getByText("Published", { exact: false }).first()).toBeVisible({ timeout: 10_000 });
  await expect(SEL.statusChip(page)).toContainText("Published");

  // Unpublish via the publish split-menu.
  await openPublishMenu(page);
  await page.getByRole("menuitem", { name: "Unpublish" }).click();
  await expect(page.getByText("Unpublished", { exact: false }).first()).toBeVisible({ timeout: 10_000 });
  await expect(SEL.statusChip(page)).toContainText("Draft");

  await trashFromTree(page, name);
});

test("schedule a future publish, then clear the schedule", async ({ page }) => {
  const name = await createPage(page, { area: "sched", type: "ArticlePage" });
  await page.getByRole("textbox", { name: /Heading/ }).fill("Scheduled heading");
  await waitForSaved(page);

  // Scheduling needs a flushed draft; ensure autosave fully settled first.
  await page.waitForTimeout(900);
  await openPublishMenu(page);
  await page.getByRole("menuitem", { name: "Schedule publish…" }).click();
  const dlg = page.getByRole("dialog", { name: "Schedule publish" });
  await expect(dlg).toBeVisible();
  // A clearly-future time → schedules the draft.
  const future = new Date(Date.now() + 7 * 24 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const val = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T08:00`;
  await dlg.getByLabel("Publish at").fill(val);
  await dlg.getByRole("button", { name: "Save schedule" }).click();
  // Success closes the dialog; then the persistent scheduled banner appears.
  await expect(dlg).toBeHidden({ timeout: 10_000 });
  await expect(page.getByText(/Scheduled to publish/)).toBeVisible({ timeout: 10_000 });

  // Clear it.
  await page.getByRole("button", { name: "Edit schedule…" }).click();
  const dlg2 = page.getByRole("dialog", { name: "Schedule publish" });
  await dlg2.getByRole("button", { name: "Clear schedule" }).click();
  await expect(page.getByText(/Scheduled to publish/)).toHaveCount(0, { timeout: 10_000 });

  await trashFromTree(page, name);
});

test("discard draft changes reverts to the last published version", async ({ page }) => {
  const name = await createPage(page, { area: "discard", type: "ArticlePage" });
  await page.getByRole("textbox", { name: /Heading/ }).fill("Original heading");
  await waitForSaved(page);
  await SEL.publishBtn(page).click();
  await expect(page.getByText("Published", { exact: false }).first()).toBeVisible({ timeout: 10_000 });

  // Make an unpublished change.
  await page.getByRole("textbox", { name: /Heading/ }).fill("Edited but not published");
  await waitForSaved(page);

  // PINNED BEHAVIOR: editing a published item creates a working DRAFT
  // (server status flips to "draft", hasUnpublishedChanges=true — verified via
  // the API). The in-memory form's onSuccess only syncs urlPath, so the chip
  // doesn't change until a reload. After reload the chip reflects the draft
  // state and the "Discard draft changes" action becomes available.
  await page.reload();
  await expect(SEL.statusChip(page)).toContainText(/Draft|changes/, { timeout: 10_000 });

  // Discard it (reverts to the last published version).
  await openPublishMenu(page);
  await page.getByRole("menuitem", { name: "Discard draft changes" }).click();
  await expect(page.getByText("Draft discarded").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("textbox", { name: /Heading/ })).toHaveValue("Original heading", { timeout: 10_000 });

  await trashFromTree(page, name);
});

test("duplicate a page produces a (copy)", async ({ page }) => {
  const name = await createPage(page, { area: "dup", type: "ArticlePage" });
  await openContentActions(page);
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(SEL.nameInput(page)).toHaveValue(`${name} (copy)`, { timeout: 10_000 });

  await trashFromTree(page, `${name} \\(copy\\)`);
  await trashFromTree(page, name);
});

test("trash a page, then restore it from Settings → Trash", async ({ page }) => {
  const name = await createPage(page, { area: "trash", type: "ArticlePage" });

  await openContentActions(page);
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await expect(page.getByText("Moved to trash").first()).toBeVisible({ timeout: 10_000 });
  await expect(SEL.treeItem(page, name)).toHaveCount(0, { timeout: 10_000 });

  // Restore from Settings → Trash.
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  const trashRow = page.getByText(name, { exact: true }).locator("xpath=ancestor::div[contains(@class,'items-center')][1]");
  await expect(trashRow).toBeVisible({ timeout: 10_000 });
  await trashRow.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Restored").first()).toBeVisible({ timeout: 10_000 });

  // Back in the editor the page exists again.
  await page.getByRole("link", { name: "Edit" }).click();
  await expect(SEL.treeItem(page, name)).toBeVisible({ timeout: 10_000 });
  await trashFromTree(page, name);
});

test("version history: make 3 versions, restore an old one, then compare A↔B", async ({ page }) => {
  const name = await createPage(page, { area: "ver", type: "ArticlePage" });

  // v1: publish "one"
  await page.getByRole("textbox", { name: /Heading/ }).fill("Heading one");
  await waitForSaved(page);
  await SEL.publishBtn(page).click();
  await expect(page.getByText("Published", { exact: false }).first()).toBeVisible({ timeout: 10_000 });

  // v2: publish "two"
  await page.getByRole("textbox", { name: /Heading/ }).fill("Heading two");
  await waitForSaved(page);
  await SEL.publishBtn(page).click();
  await expect(page.getByText(/Published/).first()).toBeVisible({ timeout: 10_000 });

  // v3: publish "three"
  await page.getByRole("textbox", { name: /Heading/ }).fill("Heading three");
  await waitForSaved(page);
  await SEL.publishBtn(page).click();
  await expect(page.getByText(/Published/).first()).toBeVisible({ timeout: 10_000 });

  // Open version history.
  await openContentActions(page);
  await page.getByRole("menuitem", { name: "Version history…" }).click();
  const dlg = page.getByRole("dialog", { name: "Version history" });
  await expect(dlg).toBeVisible();
  const rows = dlg.locator("ul > li");
  // Each publish snapshots a version; three distinct publishes give at least two
  // restorable history rows besides the live one.
  await expect.poll(async () => await rows.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

  // Restore an older (non-live) version — the last row with a Restore button.
  const restorable = rows.filter({ has: page.getByRole("button", { name: "Restore" }) });
  await expect.poll(async () => await restorable.count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
  await restorable.last().getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Version restored").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#f-heading")).not.toHaveValue("Heading three", { timeout: 10_000 });

  // Reopen and use the Compare A↔B view.
  await openContentActions(page);
  await page.getByRole("menuitem", { name: "Version history…" }).click();
  const dlg2 = page.getByRole("dialog", { name: "Version history" });
  await dlg2.getByRole("button", { name: /Compare A . B/ }).click();
  await expect(page.getByRole("dialog", { name: "Compare versions" })).toBeVisible();
  // The Heading field differs between the two compared versions.
  await expect(page.getByText("changed field", { exact: false }).first()).toBeVisible();

  await page.keyboard.press("Escape");
  await trashFromTree(page, name);
});
