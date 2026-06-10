import { expect, test } from "@playwright/test";
import { SEL, createPage, login, openHome, trashFromTree, uniqueName, waitForSaved } from "./helpers.js";

/**
 * NAVIGATION — getting around the editor:
 *  - ⌘K command palette: search content + jump to it; jump to a view.
 *  - Tree expand/collapse via the chevron.
 *  - Drag-reorder two siblings (grip handle).
 *  - Drag-to-nest (rightward drag onto another row → re-parent).
 *  - Locale switcher (en ↔ nb) on Home.
 *  - Deep-link to /edit/<id> survives a reload.
 *  - "Set as start page" flow.
 */

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("⌘K palette searches content and jumps to it", async ({ page }) => {
  await page.keyboard.press("Control+k");
  const input = page.getByPlaceholder(/Search/);
  await expect(input).toBeVisible();
  await input.fill("Author");
  await page.getByRole("option", { name: /Author Zone/ }).click();
  await expect(SEL.nameInput(page)).toHaveValue("Author Zone");
  expect(page.url()).toContain("/edit/");
});

test("⌘K palette jumps to a view (Dashboard)", async ({ page }) => {
  await page.keyboard.press("Control+k");
  await expect(page.getByPlaceholder(/Search/)).toBeVisible();
  await page.getByPlaceholder(/Search/).fill("Dashboard");
  await page.getByRole("option", { name: /Dashboard/ }).click();
  await expect(page.getByRole("heading", { name: /Newsroom dashboard/i })).toBeVisible({ timeout: 10_000 });
});

test("tree: expand and collapse a parent with children (Blog)", async ({ page }) => {
  // Blog has seeded child posts. Its row exposes an Expand/Collapse chevron.
  const blog = SEL.treeItem(page, /Blog/).first();
  await expect(blog).toBeVisible({ timeout: 15_000 });

  // Expand if not already.
  const expanded = await blog.getAttribute("aria-expanded");
  if (expanded === "false") await blog.getByRole("button", { name: "Expand" }).click();
  await expect(SEL.treeItem(page, /Hello, Paperboy/)).toBeVisible({ timeout: 10_000 });

  // Collapse: the children disappear.
  await SEL.treeItem(page, /Blog/).first().getByRole("button", { name: "Collapse" }).click();
  await expect(SEL.treeItem(page, /Hello, Paperboy/)).toHaveCount(0, { timeout: 10_000 });
});

test("tree: drag-reorder two top-level siblings (grip handle) persists", async ({ page }) => {
  // Capture the move calls so we assert a reorder fired (parentId unchanged).
  const moves: Array<{ parentId?: string | null; beforeId?: string | null; afterId?: string | null }> = [];
  page.on("request", (r) => {
    if (r.url().includes("/move") && r.method() === "POST") {
      try {
        moves.push(JSON.parse(r.postData() ?? "{}"));
      } catch {
        /* ignore */
      }
    }
  });

  // Two fresh top-level siblings so we don't disturb the seed ordering.
  const a = await createPage(page, { area: "reord-a" });
  const b = await createPage(page, { area: "reord-b" });

  const rowA = SEL.treeItem(page, a).first();
  const rowB = SEL.treeItem(page, b).first();
  await rowA.hover();
  const grip = rowA.getByLabel(/Drag to reorder/);
  const sb = (await grip.boundingBox())!;
  const db = (await rowB.boundingBox())!;
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(db.x + db.width / 2, db.y + db.height + 6, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => moves.length, { timeout: 10_000 }).toBeGreaterThan(0);
  // A reorder keeps parentId null (top level) and sets before/after.
  const reorder = moves.some((m) => (m.parentId ?? null) === null && (m.beforeId || m.afterId));
  expect(reorder).toBe(true);

  await trashFromTree(page, a);
  await trashFromTree(page, b);
});

test("tree: drag-to-nest (rightward drag) issues a re-parent", async ({ page }) => {
  const moves: Array<{ parentId?: string | null }> = [];
  page.on("request", (r) => {
    if (r.url().includes("/move") && r.method() === "POST") {
      try {
        moves.push(JSON.parse(r.postData() ?? "{}"));
      } catch {
        /* ignore */
      }
    }
  });

  const child = uniqueName("nest");
  await page.getByRole("button", { name: "Create new content" }).click();
  const dlg = page.getByRole("dialog", { name: "Create content" });
  await dlg.getByLabel("Name").fill(child);
  await dlg.getByRole("button", { name: "Create", exact: true }).click();
  const row = SEL.treeItem(page, child).first();
  await expect(row).toBeVisible({ timeout: 15_000 });

  const grip = row.getByRole("button", { name: /Drag to reorder/ });
  const home = SEL.treeItem(page, /Home/).first();
  const g = (await grip.boundingBox())!;
  const h = (await home.boundingBox())!;
  const sx = g.x + g.width / 2;
  const sy = g.y + g.height / 2;
  const ty = h.y + h.height / 2;
  // A deliberate rightward drag onto Home's body → "nest inside" intent.
  const dragRightOntoHome = async () => {
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 12, sy, { steps: 3 });
    await page.waitForTimeout(40);
    await page.mouse.move(sx + 40, ty, { steps: 10 });
    await page.waitForTimeout(40);
    await page.mouse.move(sx + 56, ty, { steps: 4 });
    await page.waitForTimeout(40);
    await page.mouse.up();
    await page.waitForTimeout(200);
  };
  const nested = () => moves.some((m) => typeof m.parentId === "string" && m.parentId.length > 0);
  for (let i = 0; i < 8 && !nested(); i++) await dragRightOntoHome();
  expect(nested(), "a rightward drag onto a row should re-parent (nest)").toBe(true);

  await trashFromTree(page, child);
});

test("locale switcher toggles en ↔ nb on Home", async ({ page }) => {
  await openHome(page);

  // Switch to Norwegian — Home is seeded as "Hjem" in nb.
  await page.getByLabel("Language").selectOption("nb");
  await expect(SEL.nameInput(page)).toHaveValue("Hjem", { timeout: 10_000 });
  expect(page.url()).toContain("lang=nb");

  // Back to English.
  await page.getByLabel("Language").selectOption("en");
  await expect(SEL.nameInput(page)).toHaveValue("Home", { timeout: 10_000 });
});

test("deep-link to /edit/<id> survives a reload (selection restored)", async ({ page }) => {
  await openHome(page);
  const url = page.url();
  expect(url).toContain("/edit/");

  await page.reload();
  await expect(SEL.nameInput(page)).toHaveValue("Home", { timeout: 15_000 });
  expect(page.url()).toBe(url);
});

test("Set as start page, then unset it", async ({ page }) => {
  // Use a fresh page so we don't permanently move the seeded start page.
  const name = await createPage(page, { area: "start", type: "ArticlePage" });
  await page.getByRole("textbox", { name: /Heading/ }).fill("Start candidate");
  await waitForSaved(page);
  // It needs a slug to be a sensible start page; the editor auto-slugs from name.

  // Set as start page from the tree context menu.
  await SEL.treeItem(page, name).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Set as start page" }).click();
  await expect(page.getByText("Start page set").first()).toBeVisible({ timeout: 10_000 });
  // The row gains the "/" served-at marker.
  await expect(SEL.treeItem(page, name).first().getByText("/", { exact: true })).toBeVisible({ timeout: 10_000 });

  // Restore the seeded start page (Home) so other tests / the web preview keep
  // working — "Set as start page" on Home re-points it (and clears ours).
  await SEL.treeItem(page, /Home/).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Set as start page" }).click();
  await expect(page.getByText("Start page set").first()).toBeVisible({ timeout: 10_000 });
  // Our page no longer carries the "/" marker.
  await expect(SEL.treeItem(page, name).first().getByText("/", { exact: true })).toHaveCount(0, { timeout: 10_000 });

  await trashFromTree(page, name);
});
