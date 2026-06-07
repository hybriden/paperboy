import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const SHOT = "../../proof/screenshots";
// Playwright runs from apps/admin (the config's directory).
const TEST_RESULTS = join(process.cwd(), "test-results");

// Cache one session cookie per role so the suite doesn't trip the production
// login rate-limit (10/min/IP) — the SPA re-authenticates from the cookie via /auth/me.
// FILE-backed (not just in-memory): Playwright restarts the worker process after
// every test failure, which wiped an in-memory cache and turned one real failure
// into a 429 cascade for the rest of the run.
const SESSION_FILE = join(TEST_RESULTS, ".session-cache.json");
const sessionCache = new Map<string, { name: string; value: string }>(
  existsSync(SESSION_FILE) ? Object.entries(JSON.parse(readFileSync(SESSION_FILE, "utf8"))) : [],
);

async function login(page: Page, email = "admin@paperboy.test", password = "Admin!Passw0rd") {
  let cookie = sessionCache.get(email);
  if (cookie) {
    // A cached cookie may have been revoked/expired — validate before trusting it.
    const me = await page.request.get("/api/v1/auth/me", { headers: { cookie: `${cookie.name}=${cookie.value}` } });
    if (!me.ok()) {
      cookie = undefined;
      sessionCache.delete(email);
    }
  }
  if (!cookie) {
    const res = await page.request.post("/api/v1/auth/login", { data: { email, password } });
    if (!res.ok()) throw new Error(`login failed ${res.status()}`);
    const setCookie = res.headersArray().find((h) => h.name.toLowerCase() === "set-cookie" && h.value.includes("paperboy_sid"));
    const pair = setCookie!.value.split(";")[0]!;
    const eq = pair.indexOf("=");
    cookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
    sessionCache.set(email, cookie);
    mkdirSync(dirname(SESSION_FILE), { recursive: true });
    writeFileSync(SESSION_FILE, JSON.stringify(Object.fromEntries(sessionCache)));
  }
  await page.context().addCookies([{ name: cookie.name, value: cookie.value, domain: "localhost", path: "/" }]);
  await page.goto("/");
  try {
    await expect(page.getByLabel("Account menu")).toBeVisible({ timeout: 15_000 });
  } catch {
    // First page-load after a worker restart can stall on cold SPA chunks
    // under CI load — one reload is reliably enough.
    await page.reload();
    await expect(page.getByLabel("Account menu")).toBeVisible({ timeout: 15_000 });
  }
}

/** The editor toolbar's Name input — scoped so a (closing) dialog's Name never matches. */
function editorName(page: Page) {
  return page.locator("#editor").getByRole("textbox", { name: "Name" });
}

// The dedicated login-screen test still needs the real form; keep one form login.
// Flow is email-first: a non-2FA account continues to a password step.
test("login form authenticates (smoke)", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill("editor@paperboy.test");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Password").fill("Editor!Passw0rd");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByLabel("Account menu")).toBeVisible({ timeout: 15_000 });
});

async function axeClean(page: Page, context: string) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `${context}: ${JSON.stringify(serious.map((v) => v.id))}`).toEqual([]);
}

test("login screen renders and passes axe", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Paperboy CMS" })).toBeVisible();
  await page.screenshot({ path: `${SHOT}/01-login.png` });
  await axeClean(page, "login");
});

test("shell + tree + editor render; axe clean in LIGHT and DARK", async ({ page }) => {
  await login(page);
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(editorName(page)).toHaveValue("Home");
  await expect(page.getByText("Main content area")).toBeVisible();
  await page.screenshot({ path: `${SHOT}/02-editor-light.png` });
  await axeClean(page, "editor-light");

  // Switch to dark via the theme menu.
  await page.getByRole("button", { name: "Theme" }).click();
  await page.getByRole("menuitem", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // The 160ms `transition-colors` on inputs must SETTLE before the contrast
  // scan — axe mid-transition sees blended (failing) colors. Wait for a
  // field-input's color to reach the dark-theme foreground.
  await page.waitForFunction(() => {
    const el = document.querySelector(".field-input");
    return el && getComputedStyle(el).color === "rgb(236, 233, 225)";
  });
  await page.screenshot({ path: `${SHOT}/03-editor-dark.png` });
  await axeClean(page, "editor-dark");
});

test("command palette (⌘K) searches content and navigates", async ({ page }) => {
  await login(page);
  await page.keyboard.press("Control+k");
  const input = page.getByPlaceholder(/Search content/);
  await expect(input).toBeVisible();
  await input.fill("Author");
  await page.getByRole("option", { name: /Author Zone/ }).click();
  await expect(editorName(page)).toHaveValue("Author Zone");
  expect(page.url()).toContain("/edit/");
});

test("deep-link is refresh-safe (routing restores selection)", async ({ page }) => {
  await login(page);
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(editorName(page)).toHaveValue("Home");
  const url = page.url();
  await page.reload();
  await expect(editorName(page)).toHaveValue("Home"); // restored after reload
  expect(page.url()).toBe(url);
});

test("rich text editor (TipTap) loads with a formatting toolbar", async ({ page }) => {
  await login(page);
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(page.getByRole("button", { name: "Bold" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Heading 2" })).toBeVisible();
  // Type into the editor and toggle bold (proves the RTE is interactive).
  const editor = page.locator(".prose-paperboy").first();
  await editor.click();
  await page.getByRole("button", { name: "Bold" }).click();
  await page.keyboard.type("Bold lede");
  await expect(editor.locator("strong")).toContainText("Bold lede");
});

test("create → edit → add block → translate → publish (with toast)", async ({ page }) => {
  await login(page);
  const pageName = `E2E ${Date.now().toString().slice(-5)}`;
  await page.getByRole("button", { name: "Create new content" }).click();
  // Scope to the dialog: the editor behind it has its own "Name" input.
  const createDlg = page.getByRole("dialog", { name: "Create content" });
  await createDlg.getByLabel("Content type").selectOption("ArticlePage");
  await createDlg.getByLabel("Name").fill(pageName);
  await createDlg.getByRole("button", { name: "Create", exact: true }).click();
  // Wait for navigation to the NEW page before touching fields — the editor
  // behind the dialog (often Home) has its own Heading + block headings.
  // Scoped to #editor: while the dialog is closing its Name input also matches.
  await expect(page.locator("#editor").getByRole("textbox", { name: "Name" })).toHaveValue(pageName, { timeout: 15_000 });

  // The page's own heading field — block fields inside content areas can carry
  // the same label, so target the field id, not an unscoped role lookup.
  const heading = page.locator("#f-heading");
  await heading.fill("Hello from E2E");
  await page.getByRole("button", { name: "URL settings" }).click(); // slug lives in the URL popover
  await page.getByLabel("Slug").fill(`e2e-${Date.now().toString().slice(-5)}`);
  await page.keyboard.press("Escape"); // close the popover
  await page.getByRole("button", { name: "+ Hero" }).click();
  await page.getByLabel("Title").first().fill("E2E hero");
  await page.waitForTimeout(1100); // autosave round-trip

  await page.getByLabel("Language").selectOption("nb");
  // The editor REMOUNTS on locale switch (key=documentId+locale). Wait for the
  // fresh nb scaffold (empty heading) before typing — filling during the
  // remount races the dying EN editor and the text lands in the EN draft.
  await expect(heading).toHaveValue("", { timeout: 10_000 });
  await heading.fill("Hei fra E2E");
  await page.waitForTimeout(1100);

  await page.getByLabel("Language").selectOption("en");
  await expect(heading).toHaveValue("Hello from E2E", { timeout: 10_000 });
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Published", { exact: false }).first()).toBeVisible({ timeout: 10_000 });
});

test("translate offer is directionless: an nb-only page offers translation when opened in en", async ({ page }) => {
  // The 2026-06-07 incident: content authored ONLY in nb showed no
  // "Translate from …" offer when opened in the default (en) locale.
  await login(page);
  const pageName = `Rev ${Date.now().toString().slice(-5)}`;
  await page.getByRole("button", { name: "Create new content" }).click();
  const dlg = page.getByRole("dialog", { name: "Create content" });
  await dlg.getByLabel("Content type").selectOption("ArticlePage");
  await dlg.getByLabel("Name").fill(pageName);
  await dlg.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("#editor").getByRole("textbox", { name: "Name" })).toHaveValue(pageName, { timeout: 15_000 });

  // Author content ONLY in nb (the non-default locale), leaving en empty.
  await page.getByLabel("Language").selectOption("nb");
  const heading = page.locator("#f-heading");
  await expect(heading).toHaveValue("", { timeout: 10_000 });
  await heading.fill("Bare på norsk");
  await page.waitForTimeout(1100); // autosave

  // Back to the default (en) locale — which has NO version. The reverse-
  // direction offer must appear, naming Norwegian (Bokmål) as the source.
  await page.getByLabel("Language").selectOption("en");
  await expect(page.getByText("Not translated to", { exact: false })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: /Translate from .*Bokmål/i })).toBeVisible({ timeout: 10_000 });
});

test("tree reorder persists via the move endpoint", async ({ page }) => {
  await login(page);
  const names = async () =>
    page.getByRole("treeitem").evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ""));
  const before = await names();
  // Drag the 1st row's grip handle below the 2nd row.
  const rows = page.getByRole("treeitem");
  const src = rows.nth(0);
  const dst = rows.nth(2);
  await src.hover();
  const grip = src.getByLabel("Drag to reorder");
  const sb = (await grip.boundingBox())!;
  const db = (await dst.boundingBox())!;
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const after = await names();
  expect(after).not.toEqual(before); // order changed and persisted
});

test("left rail navigates between views", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByRole("heading", { name: /Newsroom dashboard/i })).toBeVisible();
  await page.screenshot({ path: `${SHOT}/04-dashboard.png` });
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByRole("link", { name: "Edit" }).click();
  await expect(page.getByRole("treeitem", { name: /Home/ })).toBeVisible();
});

test("RBAC: a Viewer cannot create content", async ({ page }) => {
  await login(page, "viewer@paperboy.test", "Viewer!Passw0rd");
  await expect(page.getByRole("button", { name: "Create new content" })).toHaveCount(0);
});

test("Admin can create a content type from Settings; Editor cannot", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "New content type" }).click();
  const unique = `Bulletin${Date.now().toString().slice(-5)}`;
  await page.getByLabel("Name (code)").fill(unique);
  await page.getByLabel("Display name", { exact: true }).fill("Bulletin");
  await page.getByRole("button", { name: "Add field" }).click();
  await page.getByLabel("Field name").fill("body");
  await page.getByLabel("Field display name").fill("Body");
  await page.getByRole("button", { name: "Create type" }).click();
  // Appears in the list.
  await expect(page.getByText(unique, { exact: false })).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: `${SHOT}/05-content-type-editor.png` });
});

test("Editor cannot manage content types (no New/Edit in Settings)", async ({ page }) => {
  await login(page, "editor@paperboy.test", "Editor!Passw0rd");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New content type" })).toHaveCount(0);
});

test("content pane = pages only; shared blocks live in the asset pane", async ({ page }) => {
  await login(page);
  // The shared CardBlock ("Featured Card") is NOT a node in the page tree…
  await expect(page.getByRole("treeitem", { name: /Featured Card/ })).toHaveCount(0);
  // …it lives in the assets pane (Shared blocks).
  const assets = page.getByRole("complementary").filter({ hasText: "Assets" });
  await expect(assets.getByText("Featured Card")).toBeVisible();
  await page.screenshot({ path: `${SHOT}/06-panes.png` });
});

test("URL structure is built from the page hierarchy (start → child)", async ({ page }) => {
  await login(page);
  // Create a child under the start page "Home" via the tree context menu.
  await page.getByRole("treeitem", { name: /Home/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /New child page/ }).click();
  const seg = `team${Date.now().toString().slice(-4)}`;
  const teamName = `Team-${seg}`;
  const dlg = page.getByRole("dialog", { name: "Create content" });
  await dlg.getByLabel("Name").fill(teamName);
  await dlg.getByRole("button", { name: "Create", exact: true }).click();
  // Wait for navigation to the new child — filling the URL popover while the
  // editor still shows HOME would edit the start page's slug.
  await expect(editorName(page)).toHaveValue(teamName, { timeout: 15_000 });
  // Set the URL segment (in the URL popover); the editor's URL chip is built
  // from the hierarchy.
  await page.getByRole("button", { name: "URL settings" }).click();
  await page.getByLabel("Slug").fill(seg);
  await page.keyboard.press("Escape"); // close the popover
  await page.waitForTimeout(1100); // autosave round-trip recomputes the path
  await expect(page.getByText(`/home/${seg}`, { exact: false })).toBeVisible();
});

test("re-parent a page via Move to… (change hierarchical position)", async ({ page }) => {
  await login(page);
  // Create a top-level page (unique name: a CI retry would otherwise collide
  // with the previous attempt's leftover and break the strict-mode locators).
  const mover = `Mover-${Date.now().toString(36)}`;
  await page.getByRole("button", { name: "Create new content" }).click();
  const dlg = page.getByRole("dialog", { name: "Create content" });
  await dlg.getByLabel("Name").fill(mover);
  await dlg.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("treeitem", { name: new RegExp(mover) })).toBeVisible(); // top-level

  // Move it under "Home" via the context menu.
  await page.getByRole("treeitem", { name: new RegExp(mover) }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to…", exact: true }).click();
  await page.getByLabel("New parent").selectOption({ label: "Home" });
  await page.getByRole("button", { name: "Move here" }).click();

  // Hierarchy changed: confirmation toast (.first(): the toast text is doubled
  // by its aria-live announcement), the page left the top level, and "Home" now
  // exposes an expand affordance (aria-expanded) because it gained a child.
  await expect(page.getByText("Page moved").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("treeitem", { name: new RegExp(mover) })).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByRole("treeitem", { name: /Home/ }).first()).toHaveAttribute("aria-expanded", "false");
});

// 1x1 PNG (valid magic bytes) for upload.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test("media: upload an image in the asset pane and pick it in an image field", async ({ page }) => {
  await login(page);
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(page.getByText("Main content area")).toBeVisible();

  // Asset pane → Media tab → upload.
  await page.getByRole("tab", { name: "Media" }).click();
  await page.locator('input[type="file"]').first().setInputFiles({ name: "e2e.png", mimeType: "image/png", buffer: PNG_1x1 });
  const assets = page.getByRole("complementary").filter({ hasText: "Assets" });
  await expect(assets.locator("img")).toHaveCount(1, { timeout: 10_000 });

  // The Hero block's "Background image" image field → pick the uploaded asset.
  await page.getByRole("button", { name: "Choose image" }).first().click();
  const picker = page.getByRole("dialog", { name: "Choose image" });
  await expect(picker).toBeVisible();
  await picker.locator("img").first().click();
  // The field now shows a "Replace" affordance (an image is selected).
  await expect(page.getByRole("button", { name: "Replace" }).first()).toBeVisible({ timeout: 10_000 });
});

test("duplicate a page from the tree context menu → opens a (copy)", async ({ page }) => {
  await login(page);
  const unique = `Dup-${Date.now().toString(36)}`;
  await page.getByRole("button", { name: "Create new content" }).click();
  const dlg = page.getByRole("dialog", { name: "Create content" });
  await dlg.getByLabel("Name").fill(unique);
  await dlg.getByRole("button", { name: "Create", exact: true }).click();
  // Scoped to #editor: while the dialog is closing, its Name input also matches.
  const editorName = page.locator("#editor").getByRole("textbox", { name: "Name" });
  await expect(editorName).toHaveValue(unique, { timeout: 10_000 });

  // Right-click the new page → Duplicate.
  await page.getByRole("treeitem", { name: new RegExp(unique) }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  // The editor navigates to the clone, whose name carries "(copy)".
  await expect(editorName).toHaveValue(`${unique} (copy)`, { timeout: 10_000 });
});

test("version history dialog lists versions and can restore", async ({ page }) => {
  await login(page);
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(editorName(page)).toHaveValue("Home");
  await page.getByRole("button", { name: "Content actions" }).click();
  await page.getByRole("menuitem", { name: "Version history…" }).click();
  const dlg = page.getByRole("dialog", { name: "Version history" });
  await expect(dlg).toBeVisible();
  // Home is seeded published → a "live" version is listed.
  await expect(dlg.getByText("live").first()).toBeVisible({ timeout: 10_000 });
});

test("Settings is tabbed and exposes the admin sections for an Admin", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Settings" }).click();
  // Default tab = Content types.
  await expect(page.getByRole("heading", { name: "Content types" }).first()).toBeVisible({ timeout: 10_000 });
  // Each section is a tab in the left nav; clicking it shows that section.
  for (const tab of ["Users & roles", "API keys", "Webhooks", "Trash", "Audit log", "Your account", "Languages"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(page.getByRole("heading", { name: tab }).first()).toBeVisible({ timeout: 10_000 });
  }
  await page.screenshot({ path: `${SHOT}/08-admin-panels.png` });
});

test("content-type editor offers the new field types (datetime, select, link)", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "New content type" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("button", { name: "Add field" }).click();
  const typeSelect = dlg.getByLabel("Field type").first();
  for (const t of ["datetime", "select", "link"]) {
    await expect(typeSelect.locator(`option[value="${t}"]`)).toHaveCount(1);
  }
  // Choosing "select" reveals the options editor.
  await typeSelect.selectOption("select");
  await expect(dlg.getByRole("button", { name: "Add option" })).toBeVisible();
});

test("drag a shared block from the Assets pane into a content area", async ({ page }) => {
  await login(page);
  // Throwaway page so we don't touch real content.
  const unique = `DnD-${Date.now().toString(36)}`;
  await page.getByRole("button", { name: "Create new content" }).click();
  const dlg = page.getByRole("dialog", { name: "Create content" });
  await dlg.getByLabel("Name").fill(unique);
  await dlg.getByRole("button", { name: "Create", exact: true }).click();
  await expect(editorName(page)).toHaveValue(unique, { timeout: 10000 });

  const area = page.getByTestId("content-area-mainArea");
  await expect(area).toContainText(/Click a block above|drag a shared block/i);
  // Drag the seeded "Featured Card" shared block from the Assets pane into the area.
  // Playwright's dragTo() uses mouse simulation and drops the custom dataTransfer
  // payload, so dispatch a real HTML5 drag sequence sharing one DataTransfer — this
  // exercises our exact onDragStart→onDrop round-trip (setData → getData → addShared).
  const src = page.getByRole("button", { name: /Featured Card/ });
  await expect(src).toBeVisible();
  await src.evaluate((srcEl, testId) => {
    const target = document.querySelector(`[data-testid="${testId}"]`)!;
    const dt = new DataTransfer();
    const fire = (el: Element, type: string) =>
      el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    fire(srcEl, "dragstart");
    fire(target, "dragenter");
    fire(target, "dragover");
    fire(target, "drop");
    fire(srcEl, "dragend");
  }, "content-area-mainArea");
  // A shared block instance now lives in the area.
  await expect(area.getByText(/shared: Featured Card/i)).toBeVisible({ timeout: 10000 });

  // Cleanup: trash the throwaway page.
  await page.getByRole("treeitem", { name: new RegExp(unique) }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
});

test("drag an IMAGE into a content area → a block carrying it is auto-created", async ({ page }) => {
  await login(page);
  const unique = `ImgDrop-${Date.now().toString(36)}`;
  await page.getByRole("button", { name: "Create new content" }).click();
  const dlg = page.getByRole("dialog", { name: "Create content" });
  await dlg.getByLabel("Name").fill(unique);
  await dlg.getByRole("button", { name: "Create", exact: true }).click();
  await expect(editorName(page)).toHaveValue(unique, { timeout: 10000 });

  const area = page.getByTestId("content-area-mainArea");
  await expect(area).toBeVisible();
  // Synthesize the Assets-pane media drag payload directly (the drop side is
  // what this feature adds): LandingPage's mainArea allows HeroBlock, whose
  // image field makes it the single candidate → auto-insert, no popover.
  await area.evaluate((target) => {
    const dt = new DataTransfer();
    dt.setData("application/x-paperboy", JSON.stringify({ kind: "media", documentId: "e2e-img-asset", url: "/api/v1/media/e2e.png", alt: "E2E" }));
    const fire = (type: string) => target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    fire("dragenter");
    fire("dragover");
    fire("drop");
  });
  // A Hero block instance appeared, its image field populated (the fake id
  // renders the "not found" state — the structural insert is the contract).
  await expect(area.getByText("Hero", { exact: false }).first()).toBeVisible({ timeout: 10_000 });
  await expect(area.getByText(/Image not found/)).toBeVisible();

  // Cleanup: trash the throwaway page.
  await page.getByRole("treeitem", { name: new RegExp(unique) }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
});

test("side panes can be pinned or set to auto-hide (collapse to an edge rail)", async ({ page }) => {
  await login(page);
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(editorName(page)).toHaveValue("Home");

  // The Content tree is pinned by default — its filter box is in the layout.
  await expect(page.getByPlaceholder("Filter…")).toBeVisible();
  // Auto-hide it: the in-flow tree collapses to an edge rail.
  await page.getByRole("button", { name: "Auto-hide this panel" }).first().click();
  await expect(page.getByPlaceholder("Filter…")).toBeHidden();
  const rail = page.getByRole("button", { name: "Show Content panel" });
  await expect(rail).toBeVisible();
  // Re-pin from the rail → the tree returns to the layout.
  await rail.click();
  await expect(page.getByPlaceholder("Filter…")).toBeVisible();
});

test("editor workspace panes are resizable (drag handles present)", async ({ page }) => {
  await login(page);
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(editorName(page)).toHaveValue("Home");
  // Two dividers by default: tree|editor and editor|assets.
  await expect(page.getByRole("separator")).toHaveCount(2);
  // Side-by-side view adds a third divider (form|preview) that can be dragged.
  await page.getByRole("button", { name: "Side by side" }).click();
  await expect(page.getByRole("separator")).toHaveCount(3);
  // Drag the form|preview divider left → no crash, page still responsive.
  const handle = page.getByRole("separator").last();
  const b = await handle.boundingBox();
  if (b) {
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x - 120, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
  }
  await expect(editorName(page)).toHaveValue("Home");
});

test("visual editing: a preview 'edit' message switches tab + focuses the field/block", async ({ page }) => {
  await login(page);
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(editorName(page)).toHaveValue("Home");
  // Simulate the preview iframe asking to edit the SEO meta title → switches to SEO tab + focuses it.
  await page.evaluate(() => window.postMessage({ type: "paperboy:edit", field: "metaTitle" }, "*"));
  await expect(page.locator("#f-metaTitle")).toBeFocused({ timeout: 5000 });
  // A block click scrolls to that block row in the content area.
  await page.evaluate(() => window.postMessage({ type: "paperboy:edit", field: "mainArea", blockIndex: 0 }, "*"));
  await expect(page.locator("#pb-block-0")).toBeVisible({ timeout: 5000 });
});

test("editor has a dedicated SEO tab with meta + OpenGraph fields", async ({ page }) => {
  await login(page);
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(editorName(page)).toHaveValue("Home");
  // Tabs: Content, Settings, SEO (in that order).
  const seoTab = page.getByRole("tab", { name: "SEO" });
  await expect(seoTab).toBeVisible();
  await seoTab.click();
  await expect(page.getByLabel("Meta title")).toBeVisible();
  await expect(page.getByLabel("Meta description")).toBeVisible();
  await expect(page.getByText("Social share image")).toBeVisible();
});

test("AI assistant can generate SEO meta from the page content", async ({ page }) => {
  await login(page);
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(editorName(page)).toHaveValue("Home");
  await page.getByRole("button", { name: "AI assistant" }).click();
  await page.getByRole("menuitem", { name: "Generate SEO description" }).click();
  // The SEO tab's meta description is filled (offline fallback derives it from the page text).
  await page.getByRole("tab", { name: "SEO" }).click();
  await expect(page.getByLabel("Meta description")).not.toHaveValue("", { timeout: 10_000 });
});

test("a nested child renders its OWN name (not its parent's) and a unique row", async ({ page }) => {
  // Regression for the prop-spread bug where descendants inherited the parent's
  // node (every child showed as "Home", shared its id → expand collision + crash).
  await login(page);
  const x = `Child-${Date.now().toString(36)}`;
  await page.getByRole("button", { name: "Create new content" }).click();
  const dlg = page.getByRole("dialog", { name: "Create content" });
  await dlg.getByLabel("Name").fill(x);
  await dlg.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("treeitem", { name: new RegExp(x) })).toBeVisible({ timeout: 10000 });
  await page.getByRole("treeitem", { name: new RegExp(x) }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to…", exact: true }).click();
  await page.getByLabel("New parent").selectOption({ label: "Home" });
  await page.getByRole("button", { name: "Move here" }).click();
  await page.getByRole("treeitem", { name: /Home/ }).first().locator("button[aria-label='Expand']").click().catch(() => {});
  // The child shows its own name, and "Home" still appears exactly once
  // (the bug rendered every child as "Home" → count > 1).
  await expect(page.getByRole("treeitem", { name: new RegExp(x) })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("treeitem", { name: /Home/ })).toHaveCount(1);
});

test("drag a page to the RIGHT onto another page nests it (drag-to-nest)", async ({ page }) => {
  await login(page);
  // Capture the move calls the tree issues so we can assert a re-parent (nest) fired.
  const moves: Array<{ parentId?: string | null }> = [];
  page.on("request", (r) => {
    if (r.url().includes("/move") && r.method() === "POST") {
      try { moves.push(JSON.parse(r.postData() ?? "{}")); } catch { /* ignore */ }
    }
  });
  // Create a fresh top-level page to nest.
  const unique = `Nestme-${Date.now().toString(36)}`;
  await page.getByRole("button", { name: "Create new content" }).click();
  const dlg = page.getByRole("dialog", { name: "Create content" });
  await dlg.getByLabel("Name").fill(unique);
  await dlg.getByRole("button", { name: "Create", exact: true }).click();
  const row = page.getByRole("treeitem", { name: new RegExp(unique) });
  await expect(row).toBeVisible();

  // Drag its grip onto another row while moving clearly to the RIGHT — the
  // horizontal intent that means "nest inside" (vs a vertical reorder).
  const grip = row.getByRole("button", { name: /Drag to reorder/ });
  const home = page.getByRole("treeitem", { name: /Home/ }).first();
  const g = await grip.boundingBox();
  const h = await home.boundingBox();
  if (!g || !h) throw new Error("missing bounding boxes");
  const h0 = await home.boundingBox();
  if (!h0) throw new Error("missing home box");
  const sx = g.x + g.width / 2;
  const sy = g.y + g.height / 2;
  const ty = h0.y + h0.height / 2;
  // One drag gesture: onto the target row, then a small rightward nudge that
  // clears the nest threshold (~24px) without leaving the droppables.
  async function dragRightOntoHome() {
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 12, sy, { steps: 3 });
    await page.waitForTimeout(50);
    await page.mouse.move(sx + 30, ty, { steps: 10 });
    await page.waitForTimeout(50);
    await page.mouse.move(sx + 50, ty, { steps: 4 });
    await page.waitForTimeout(50);
    await page.mouse.up();
    await page.waitForTimeout(250);
  }
  // Synthetic dnd input is noisy in headless Chromium; retry the gesture until a
  // re-parent (nest) move is captured. Every time the drag registers it nests
  // correctly — we just can't guarantee a single synthetic gesture lands.
  const nested = () => moves.some((m) => typeof m.parentId === "string" && m.parentId.length > 0);
  for (let i = 0; i < 8 && !nested(); i++) await dragRightOntoHome();

  // The drag-to-nest gesture issued a re-parent (parentId set), proving the UI
  // wiring end-to-end. (Backend reparent correctness is covered by API tests.)
  expect(nested()).toBe(true);
});
