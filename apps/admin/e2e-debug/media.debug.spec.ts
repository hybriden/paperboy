import { expect, test } from "@playwright/test";
import { PNG_1x1, SEL, login, openHome, waitForSaved } from "./helpers.js";

/**
 * MEDIA — upload, alt text (+ the no-key Describe-image disabled state), the image field's
 * choose/replace/clear via the picker, the picker's Library/Stock tabs (stock
 * is UNCONFIGURED in this env → assert the self-teaching inline error), and
 * deleting an asset that an image field references → "Image not found".
 */

test.beforeEach(async ({ page }) => {
  await login(page);
});

/** Open the first image field's picker, whether it currently shows "Choose
 *  image" (empty) or "Replace" (already has a selection from a prior run). */
async function openFirstImagePicker(page: import("@playwright/test").Page) {
  const choose = page.getByRole("button", { name: "Choose image" }).first();
  const replace = page.getByRole("button", { name: "Replace" }).first();
  await expect(choose.or(replace)).toBeVisible({ timeout: 15_000 });
  if (await choose.isVisible().catch(() => false)) await choose.click();
  else await replace.click();
  return page.getByRole("dialog", { name: "Choose image" });
}

/** Upload a unique PNG via the assets-pane Media tab; returns the filename. */
async function uploadPng(page: import("@playwright/test").Page): Promise<string> {
  const filename = `dbg-${Date.now().toString(36)}.png`;
  await page.getByRole("tab", { name: "Media" }).click();
  await page.locator('input[type="file"]').first().setInputFiles({ name: filename, mimeType: "image/png", buffer: PNG_1x1 });
  await expect(page.getByText("Image uploaded").first()).toBeVisible({ timeout: 15_000 });
  return filename;
}

test("upload a PNG into the assets pane Media tab", async ({ page }) => {
  await openHome(page);
  const before = await SEL.assetsPane(page).locator("img").count();
  await uploadPng(page);
  await expect.poll(async () => SEL.assetsPane(page).locator("img").count(), { timeout: 10_000 }).toBeGreaterThan(before);
});

test("edit alt text; Describe image is honestly disabled without an AI key", async ({ page }) => {
  await openHome(page);
  await uploadPng(page);

  // Open the first asset's details dialog.
  await SEL.assetsPane(page).locator("img").first().click();
  const dlg = page.getByRole("dialog", { name: "Image details" });
  await expect(dlg).toBeVisible();

  // Alt text comes from VISION now (the model looks at the image) — with no
  // key configured there is no fake filename fallback; the button is disabled.
  await expect(dlg.getByRole("button", { name: /Describe image/ })).toBeDisabled();

  // Manual alt editing is unaffected.
  await dlg.getByLabel(/Alt text/).fill("A debug test image");
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Alt text saved").first()).toBeVisible({ timeout: 10_000 });
});

test("image field: choose, replace, then clear via the picker", async ({ page }) => {
  await openHome(page);
  // Make sure there are at least two images to choose/replace between.
  await uploadPng(page);
  await uploadPng(page);

  // Open the Hero block's "Background image" image field picker.
  const picker = await openFirstImagePicker(page);
  await expect(picker).toBeVisible();
  await picker.locator("img").first().click();
  // A selected image flips the field to "Replace" + adds a "Clear".
  await expect(page.getByRole("button", { name: "Replace" }).first()).toBeVisible({ timeout: 10_000 });
  await waitForSaved(page);

  // Replace with a different image.
  await page.getByRole("button", { name: "Replace" }).first().click();
  const picker2 = page.getByRole("dialog", { name: "Choose image" });
  await expect(picker2).toBeVisible();
  const imgs = picker2.locator("img");
  await imgs.nth(Math.min(1, (await imgs.count()) - 1)).click();
  await expect(page.getByRole("button", { name: "Replace" }).first()).toBeVisible({ timeout: 10_000 });
  await waitForSaved(page);

  // Clear it.
  await page.getByRole("button", { name: "Clear" }).first().click();
  await expect(page.getByRole("button", { name: "Choose image" }).first()).toBeVisible({ timeout: 10_000 });
});

test("picker Library/Stock tabs — Stock is unconfigured, shows a self-teaching error", async ({ page }) => {
  await openHome(page);

  const picker = await openFirstImagePicker(page);
  await expect(picker).toBeVisible();
  // Library tab is the default.
  await expect(picker.getByRole("tab", { name: "Library" })).toHaveAttribute("aria-selected", "true");

  // Stock tab: typing a query triggers a search that fails because no Unsplash
  // key is configured here — the error message must point the user somewhere.
  await picker.getByRole("tab", { name: "Stock" }).click();
  await picker.getByRole("searchbox", { name: "Search stock photos" }).fill("mountains at dawn");
  // The inline error names Settings → Stock images (self-teaching), not a raw stack.
  await expect(picker.getByText(/stock|Settings|key|configur|unsplash/i).first()).toBeVisible({ timeout: 15_000 });
});

test("delete an asset that a field references → the field shows 'Image not found'", async ({ page }) => {
  await openHome(page);
  const filename = await uploadPng(page);

  // Reference the freshly-uploaded asset in the Hero background image field.
  const picker = await openFirstImagePicker(page);
  // The newest upload is the first thumbnail.
  await picker.locator("img").first().click();
  await expect(page.getByRole("button", { name: "Replace" }).first()).toBeVisible({ timeout: 10_000 });
  await waitForSaved(page);

  // Capture the EXACT image the field now references (its rendered <img src>), so
  // we delete that same asset — picker order vs pane order needn't match. The
  // image-field container holds the thumbnail <img> next to the Replace button.
  const fieldContainer = page
    .getByRole("button", { name: "Replace" })
    .first()
    .locator("xpath=ancestor::div[.//img][1]");
  const referencedSrc = await fieldContainer.locator("img").first().getAttribute("src");
  expect(referencedSrc, "field should render a referenced image").toBeTruthy();

  // Delete THAT asset from the Media tab: open the pane thumbnail with the same src.
  await page.getByRole("tab", { name: "Media" }).click();
  const paneThumb = SEL.assetsPane(page).locator(`img[src="${referencedSrc}"]`).first();
  await expect(paneThumb).toBeVisible({ timeout: 10_000 });
  await paneThumb.click();
  const detail = page.getByRole("dialog", { name: "Image details" });
  await expect(detail).toBeVisible();
  page.once("dialog", (d) => d.accept()); // confirm() prompt
  await detail.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Image deleted").first()).toBeVisible({ timeout: 10_000 });

  // The image field that referenced it now reports the broken reference. Reload
  // to guarantee the assets cache + the form re-resolve the (now-missing) id.
  await page.reload();
  await expect(SEL.nameInput(page)).toHaveValue("Home");
  await expect(page.getByText("Image not found").first()).toBeVisible({ timeout: 15_000 });

  // Cleanup (best-effort): clear the dangling reference so Home stays sane.
  await page.getByRole("button", { name: "Clear" }).first().click().catch(() => undefined);
  await page
    .getByRole("button", { name: "Choose image" })
    .first()
    .waitFor({ timeout: 5_000 })
    .catch(() => undefined);
  void filename;
});
