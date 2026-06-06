import { expect, test } from "@playwright/test";
import { PNG_1x1, SEL, createPage, login, trashFromTree, uniqueName, waitForSaved } from "./helpers.js";

/**
 * RICHTEXT + MARKDOWN editors.
 *
 * RichText (TipTap) on an ArticlePage "Intro": every toolbar control (bold,
 * italic, H2, H3, bullet list, quote, link via window.prompt, undo, redo),
 * insert image via the toolbar picker, and drag-resize the inserted image (mouse
 * down on .pb-rt-img-handle, move, up → the width attr/style changes).
 *
 * Markdown editor on a BlogPost "Body": toolbar buttons + Write/Preview toggle.
 */

test.beforeEach(async ({ page }) => {
  await login(page);
});

/** The Intro richtext field's TipTap editor surface (ArticlePage). */
const introEditor = (page: import("@playwright/test").Page) => page.locator("#f-intro");

test("TipTap toolbar: bold, italic, H2, H3, bullet list, quote all apply", async ({ page }) => {
  const name = await createPage(page, { area: "rt", type: "ArticlePage" });
  const editor = introEditor(page);
  await editor.click();

  // Bold
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await page.keyboard.type("BoldText");
  await expect(editor.locator("strong")).toContainText("BoldText");

  // Newline, then italic
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Italic", exact: true }).click();
  await page.keyboard.type("ItalicText");
  await expect(editor.locator("em")).toContainText("ItalicText");

  // H2
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Heading 2" }).click();
  await page.keyboard.type("Big Heading");
  await expect(editor.locator("h2")).toContainText("Big Heading");

  // H3
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Heading 3" }).click();
  await page.keyboard.type("Sub Heading");
  await expect(editor.locator("h3")).toContainText("Sub Heading");

  // Bullet list
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Bullet list" }).click();
  await page.keyboard.type("Item one");
  await expect(editor.locator("ul li")).toContainText("Item one");

  // Quote
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // exit the list
  await page.getByRole("button", { name: "Quote" }).click();
  await page.keyboard.type("A quotation");
  await expect(editor.locator("blockquote")).toContainText("A quotation");

  await waitForSaved(page);
  await trashFromTree(page, name);
});

test("TipTap link via the window.prompt dialog, then undo/redo", async ({ page }) => {
  const name = await createPage(page, { area: "rtlink", type: "ArticlePage" });
  const editor = introEditor(page);
  await editor.click();
  await page.keyboard.type("clickme");
  // Select the typed word.
  await page.keyboard.press("Shift+Home");

  // The Link button prompts for a URL via window.prompt — handle the dialog.
  page.once("dialog", (d) => {
    expect(d.type()).toBe("prompt");
    void d.accept("https://example.com/debug");
  });
  await page.getByRole("button", { name: "Link", exact: true }).click();
  await expect(editor.locator('a[href="https://example.com/debug"]')).toHaveText("clickme");

  // Undo removes the link mark.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(editor.locator('a[href="https://example.com/debug"]')).toHaveCount(0);
  // Redo restores it.
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(editor.locator('a[href="https://example.com/debug"]')).toHaveCount(1);

  await waitForSaved(page);
  await trashFromTree(page, name);
});

test("TipTap: insert an image via the toolbar picker, then drag-resize it", async ({ page }) => {
  const name = await createPage(page, { area: "rtimg", type: "ArticlePage" });

  // Ensure there's an image to insert.
  await page.getByRole("tab", { name: "Media" }).click();
  await page.locator('input[type="file"]').first().setInputFiles({ name: uniqueName("rt") + ".png", mimeType: "image/png", buffer: PNG_1x1 });
  await expect(page.getByText("Image uploaded").first()).toBeVisible({ timeout: 15_000 });

  const editor = introEditor(page);
  await editor.click();
  // The richtext toolbar's "Insert image" opens the media picker.
  await page.getByRole("button", { name: "Insert image" }).click();
  const picker = page.getByRole("dialog", { name: "Choose image" });
  await expect(picker).toBeVisible();
  await picker.locator("img").first().click();

  // The image lands as a resizable node (.pb-rt-img wrapper + handle).
  const wrapper = editor.locator(".pb-rt-img").first();
  await expect(wrapper).toBeVisible({ timeout: 10_000 });
  const handle = wrapper.locator(".pb-rt-img-handle");
  await expect(handle).toBeAttached();

  // Drag the corner handle leftwards to shrink the image; the wrapper's width
  // style (percent of the text column) should change. The handle resizes via
  // pointer events, so drive a deliberate gesture with intermediate moves +
  // settles so the pointermove listener fires (a single jump can be missed).
  const before = await wrapper.evaluate((el) => (el as HTMLElement).style.width || "100%");
  await handle.scrollIntoViewIfNeeded();
  const hb = (await handle.boundingBox())!;
  const cx = hb.x + hb.width / 2;
  const cy = hb.y + hb.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 30, cy, { steps: 5 });
  await page.waitForTimeout(50);
  await page.mouse.move(cx - 90, cy, { steps: 8 });
  await page.waitForTimeout(50);
  await page.mouse.move(cx - 150, cy, { steps: 8 });
  await page.waitForTimeout(50);
  await page.mouse.up();
  // The committed width is a percent below the starting 100% (image shrank).
  await expect
    .poll(async () => wrapper.evaluate((el) => (el as HTMLElement).style.width), { timeout: 8_000 })
    .not.toBe(before);
  const width = await wrapper.evaluate((el) => (el as HTMLElement).style.width);
  expect(width).toMatch(/^\d+(\.\d+)?%$/);

  await waitForSaved(page);
  await trashFromTree(page, name);
});

test("Markdown editor: toolbar buttons insert syntax + Write/Preview toggle renders", async ({ page }) => {
  // Create a BlogPost (its Body field is markdown) under the seeded Blog page.
  await SEL.treeItem(page, "Blog").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: /New child page/ }).click();
  const dlg = page.getByRole("dialog", { name: "Create content" });
  await dlg.getByLabel("Content type").selectOption("BlogPost");
  const name = uniqueName("md");
  await dlg.getByLabel("Name").fill(name);
  await dlg.getByRole("button", { name: "Create", exact: true }).click();
  await expect(SEL.nameInput(page)).toHaveValue(name, { timeout: 15_000 });

  // Anchor to the Body field WRAPPER (the data-pb-prop div), not the textarea —
  // toggling to Preview swaps the textarea out, which would detach a
  // textarea-anchored locator.
  const mdField = page.locator('[data-pb-prop="body"]');
  const mdToolbar = mdField;
  const textarea = page.locator("#f-body");

  // Three blank-line-separated lines so marked renders distinct blocks; the
  // caret ends on the LAST line.
  await textarea.click();
  await page.keyboard.type("Heading line\n\nbold me\n\nlist item");

  // Bullet list: the caret is on "list item" — prefix that line.
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  await page.keyboard.press("End");
  await page.keyboard.up("Shift");
  await mdToolbar.getByRole("button", { name: "Bullet list" }).click();
  await expect(textarea).toHaveValue(/- list item$/);

  // Bold: select the "bold me" line (3rd from end) and wrap it.
  await page.locator("#f-body").evaluate((el: HTMLTextAreaElement) => {
    const i = el.value.indexOf("bold me");
    el.focus();
    el.setSelectionRange(i, i + "bold me".length);
  });
  await mdToolbar.getByRole("button", { name: "Bold" }).click();
  await expect(textarea).toHaveValue(/\*\*bold me\*\*/);

  // H2: select the "Heading line" and prefix it.
  await page.locator("#f-body").evaluate((el: HTMLTextAreaElement) => {
    const i = el.value.indexOf("Heading line");
    el.focus();
    el.setSelectionRange(i, i + "Heading line".length);
  });
  await mdToolbar.getByRole("button", { name: "Heading" }).click();
  await expect(textarea).toHaveValue(/^## Heading line/);

  // Toggle to Preview → rendered HTML (h2 from "## ", strong from "**", li from "- ").
  await mdToolbar.getByRole("button", { name: "preview" }).click();
  await expect(mdField.locator("h2")).toContainText("Heading line", { timeout: 10_000 });
  await expect(mdField.locator("strong")).toContainText("bold me");
  await expect(mdField.locator("li")).toContainText("list item");

  // Back to Write.
  await mdToolbar.getByRole("button", { name: "write" }).click();
  await expect(textarea).toBeVisible();

  await waitForSaved(page);
  await trashFromTree(page, name);
});
