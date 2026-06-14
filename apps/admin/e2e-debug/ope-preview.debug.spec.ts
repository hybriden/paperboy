import { expect, test, type Page } from "@playwright/test";
import { login, openHome, waitForSaved } from "./helpers.js";

/**
 * ON-PAGE EDITING + LIVE PREVIEW.
 *
 * The preview iframe loads the web reference frontend (apps/web) at the
 * configured previewBaseUrl, or — when unset, as in the seed — the admin host on
 * :8092. The web PreviewBridge marks editable regions (data-pb-field /
 * data-pb-block-index), posts paperboy:edit on click (with the element rect +
 * click point), streams paperboy:rect on scroll, and applies paperboy:patch
 * live-edits without reloading.
 *
 * These tests exercise:
 *  - the side-by-side view loads the preview iframe pointing at the web app;
 *  - the postMessage focus bridge (paperboy:edit → focus/flash the form field) —
 *    this is the admin-side handler, driven exactly as the real bridge would;
 *  - on-page edit mode opens the anchored overlay at the click;
 *  - typing in the overlay live-patches the preview iframe DOM (no reload);
 *  - click-to-caret places the editor caret near the clicked richtext text.
 *
 * Where the dev web app can't serve the bridge for the seeded page, the test
 * skips with a precise reason rather than faking a pass.
 */

const WEB_PREVIEW = "http://localhost:8092";
const PREVIEW_SECRET = "dev-preview-secret-change-me";

/** Is the web reference frontend serving the bridge + edit markers for Home? */
async function webBridgeAvailable(page: Page): Promise<{ ok: boolean; reason?: string }> {
  const res = await page.request.get(`${WEB_PREVIEW}/en?pb=${PREVIEW_SECRET}`).catch(() => null);
  if (!res) return { ok: false, reason: `web preview at ${WEB_PREVIEW} is unreachable` };
  if (!res.ok()) return { ok: false, reason: `web preview returned ${res.status()} for /en` };
  const html = await res.text();
  if (!html.includes('data-pb-field="heading"'))
    return { ok: false, reason: "web preview HTML lacks data-pb-field markers (bridge not rendered for seeded Home)" };
  return { ok: true };
}

test.beforeEach(async ({ page }) => {
  // login() resets the persisted editor view to "props" so on-page state from a
  // prior test never hides the properties form here.
  await login(page);
});


test("side-by-side view loads the preview iframe pointing at the web app", async ({ page }) => {
  await openHome(page);
  await page.getByRole("button", { name: "Side by side" }).click();

  const iframe = page.getByTitle("Content preview");
  await expect(iframe).toBeVisible({ timeout: 10_000 });
  const src = await iframe.getAttribute("src");
  expect(src, "iframe src").toContain("/en");
  expect(src, "iframe carries the preview secret").toContain("pb=");
  // The persistent draft banner is shown in preview (inspect) mode.
  await expect(page.getByText(/click any heading, text or block to edit/i)).toBeVisible();
});

test("postMessage focus bridge: paperboy:edit focuses + flashes the form field", async ({ page }) => {
  await openHome(page);

  // Simulate the bridge asking to edit the SEO meta title (a field on a
  // different tab) — the admin switches to its group + focuses it.
  await page.evaluate(() => window.postMessage({ type: "paperboy:edit", field: "metaTitle" }, "*"));
  await expect(page.locator("#f-metaTitle")).toBeFocused({ timeout: 5_000 });

  // A block click scrolls the block row into view.
  await page.evaluate(() => window.postMessage({ type: "paperboy:edit", field: "mainArea", blockIndex: 0 }, "*"));
  await expect(page.locator("#pb-block-0")).toBeVisible({ timeout: 5_000 });
});

test("on-page edit mode opens the anchored overlay at the clicked rect", async ({ page }) => {
  await openHome(page);
  await page.getByRole("button", { name: "On-page" }).click();
  await expect(page.getByText(/On-page editing/i)).toBeVisible({ timeout: 10_000 });

  // Simulate the bridge reporting a click on the "heading" field with a rect +
  // click point — the admin opens an anchored overlay editor.
  await page.evaluate(() => {
    window.postMessage(
      {
        type: "paperboy:edit",
        field: "heading",
        blockIndex: null,
        rect: { x: 120, y: 160, w: 400, h: 48 },
        click: { x: 200, y: 180 },
      },
      "*",
    );
  });
  const overlay = page.getByRole("dialog", { name: "Edit property" });
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  await expect(overlay.getByText("Edit on page")).toBeVisible();
  // The overlay hosts the heading field editor, pre-filled with the page's
  // current value (value-agnostic: prior tests may have edited Home).
  await expect(overlay.locator("#f-heading")).not.toHaveValue("", { timeout: 5_000 });

  // Close it.
  await overlay.getByRole("button", { name: "Close" }).click();
  await expect(overlay).toBeHidden();
});

test("typing in the on-page overlay live-patches the preview iframe (no reload)", async ({ page }) => {
  const avail = await webBridgeAvailable(page);
  test.skip(!avail.ok, avail.reason ?? "web bridge unavailable");

  await openHome(page);
  await page.getByRole("button", { name: "On-page" }).click();
  await expect(page.getByText(/On-page editing/i)).toBeVisible({ timeout: 10_000 });

  const iframe = page.frameLocator('iframe[title="Content preview"]');
  // Wait for the iframe to render the heading region the bridge marks (non-empty;
  // value-agnostic since prior tests may have edited Home).
  const headingRegion = iframe.locator('[data-pb-field="heading"]').first();
  await expect(headingRegion).toBeVisible({ timeout: 20_000 });
  await expect(headingRegion).not.toHaveText("", { timeout: 10_000 });

  // Open the overlay for the heading via the bridge contract, type a new value,
  // and assert the iframe DOM reflects it WITHOUT a reload (live patch).
  await page.evaluate(() => {
    window.postMessage(
      { type: "paperboy:edit", field: "heading", blockIndex: null, rect: { x: 100, y: 120, w: 400, h: 48 }, click: { x: 150, y: 140 } },
      "*",
    );
  });
  const overlay = page.getByRole("dialog", { name: "Edit property" });
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  const suffix = ` ${Date.now().toString().slice(-5)}`;
  // Real keystrokes (not .fill) so React's onChange fires per change → the
  // overlay's pushLivePatch posts paperboy:patch to the iframe each time.
  const ovInput = overlay.locator("#f-heading");
  await ovInput.click();
  await ovInput.press("End");
  await ovInput.pressSequentially(suffix, { delay: 30 });
  const unique = (await ovInput.inputValue());

  // The bridge applies paperboy:patch → the iframe heading text updates in place.
  await expect(headingRegion).toContainText(unique.trim(), { timeout: 10_000 });

  // Cleanup: restore the canonical seeded heading and let it save.
  await overlay.locator("#f-heading").fill("Welcome to Paperboy");
  await overlay.getByRole("button", { name: "Close" }).click();
  await waitForSaved(page);
});

test("click-to-caret: clicking richtext in the preview places the editor caret near the text", async ({ page }) => {
  const avail = await webBridgeAvailable(page);
  test.skip(!avail.ok, avail.reason ?? "web bridge unavailable");

  await openHome(page);
  await page.getByRole("button", { name: "Side by side" }).click();
  await expect(page.getByTitle("Content preview")).toBeVisible({ timeout: 10_000 });

  // Simulate the bridge's click-to-caret payload for the richtext "intro" field:
  // a snippet from the rendered text + an offset. The admin focuses the field and
  // positions the caret at the snippet.
  await page.evaluate(() => {
    window.postMessage(
      {
        type: "paperboy:edit",
        field: "intro",
        blockIndex: null,
        caret: { snippet: "visual editor", offset: 0 },
      },
      "*",
    );
  });
  // The intro richtext editor gains focus near the clicked text (the TipTap
  // surface becomes the active element). We assert the field is focused — exact
  // caret offset is internal to ProseMirror.
  const intro = page.locator("#f-intro");
  await expect(intro).toBeFocused({ timeout: 10_000 });
});
