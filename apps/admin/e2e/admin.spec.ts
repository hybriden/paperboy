import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { type Locator, type Page, expect, test } from "@playwright/test";

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

/** The editor toolbar's Name input — scoped so a (closing) dialog's Name never
 *  matches, and EXACT so a block field whose label merely contains "name"
 *  (e.g. "Person name") isn't ambiguous with the page's own Name. */
function editorName(page: Page) {
  return page.locator("#editor").getByRole("textbox", { name: "Name", exact: true });
}

// The dedicated login-screen test still needs the real form; keep one form login.
// Flow is email-first: a non-2FA account continues to a password step.
test("login form authenticates (smoke)", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill("editor@paperboy.test");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: "Password" }).fill("Editor!Passw0rd");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByLabel("Account menu")).toBeVisible({ timeout: 15_000 });
});

// PWA install contract: the manifest and every icon it names must be served.
// A renamed/moved icon would silently break already-installed admin apps.
test("PWA manifest and icons are served", async ({ page }) => {
  const res = await page.request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("manifest+json");
  const manifest = (await res.json()) as { name: string; display: string; icons: { src: string }[] };
  expect(manifest.name).toBe("Paperboy CMS");
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
  for (const icon of manifest.icons) {
    const r = await page.request.get(icon.src);
    expect(r.status(), icon.src).toBe(200);
    expect(r.headers()["content-type"], icon.src).toBe("image/png");
  }
});

async function axeClean(page: Page, context: string) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `${context}: ${JSON.stringify(serious.map((v) => v.id))}`).toEqual([]);
}

test("login screen renders and passes axe", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Paperboy", level: 1 })).toBeVisible();
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
  // scan — axe mid-transition sees blended (failing) colors.
  //
  // Waits for the colour to STOP CHANGING rather than for one specific rgb():
  // the old form hardcoded a token value and read "whichever .field-input is
  // first in the DOM", so it broke the moment the properties pane's markup
  // changed. Two equal samples 120ms apart means a 160ms transition is done.
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".field-input");
      if (!el) return false;
      const now = getComputedStyle(el).color;
      const w = window as unknown as { __pbLastColor?: string };
      const settled = w.__pbLastColor === now;
      w.__pbLastColor = now;
      return settled;
    },
    undefined,
    { polling: 120 },
  );
  await page.screenshot({ path: `${SHOT}/03-editor-dark.png` });
  await axeClean(page, "editor-dark");
});

test("command palette (⌘K) searches content and navigates", async ({ page }) => {
  await login(page);
  await page.keyboard.press("Control+k");
  // Match on "Search" only — the palette placeholder copy is a design choice
  // that has already changed once ("Search content…" → "Search the newsroom…").
  const input = page.getByPlaceholder(/Search/);
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
  await expect(editorName(page)).toHaveValue(pageName, { timeout: 15_000 });

  // The page's own heading field — block fields inside content areas can carry
  // the same label, so target the field id, not an unscoped role lookup.
  const heading = page.locator("#f-heading");
  await heading.fill("Hello from E2E");
  await page.getByRole("button", { name: "URL settings" }).click(); // slug lives in the URL popover
  await page.getByLabel("Slug").fill(`e2e-${Date.now().toString().slice(-5)}`);
  await page.keyboard.press("Escape"); // close the popover
  await addBlock(page, "Hero");
  await openBlock(page);
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

test("translate offer is directionless: content authored only in nb offers translation when opened in en", async ({ page }) => {
  // The 2026-06-07 incident: content authored ONLY in nb showed no
  // "Translate from …" offer when opened in the default (en) locale — the
  // offer was one-way (default→other only). After the fix it is directionless:
  // whenever the current locale is empty and ANOTHER has content, offer it.
  await login(page);
  const pageName = `Rev ${Date.now().toString().slice(-5)}`;
  await page.getByRole("button", { name: "Create new content" }).click();
  const dlg = page.getByRole("dialog", { name: "Create content" });
  await dlg.getByLabel("Content type").selectOption("ArticlePage");
  await dlg.getByLabel("Name").fill(pageName);
  await dlg.getByRole("button", { name: "Create", exact: true }).click();
  await expect(editorName(page)).toHaveValue(pageName, { timeout: 15_000 });

  // Author content ONLY in nb; the en variant created by the dialog stays empty.
  await page.getByLabel("Language").selectOption("nb");
  const heading = page.locator("#f-heading");
  await expect(heading).toHaveValue("", { timeout: 10_000 });
  await heading.fill("Bare på norsk");
  await page.waitForTimeout(1100); // autosave round-trip

  // Back to en (empty) — the reverse-direction offer must appear, naming
  // Norwegian (Bokmål) as the source.
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
  // Let the Settings panel finish mounting before interacting — ContentTypesPanel
  // re-renders as its data queries resolve, which can detach the action button
  // mid-click under CI load. Wait for the (static) panel heading first.
  await expect(page.getByRole("heading", { name: "Content types" }).first()).toBeVisible();
  await page.getByRole("button", { name: "New content type" }).click();
  // The template gallery opens first — this test builds a type from scratch.
  await page.getByRole("dialog").getByRole("button", { name: "Start blank" }).click();
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
  // The block's fields are behind its row, so open it first: this page's block
  // comes from the seed rather than from a palette click, which is why it needs
  // opening here and not just after an add.
  await openBlock(page);
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
  const nameInput = editorName(page);
  await expect(nameInput).toHaveValue(unique, { timeout: 10_000 });

  // Right-click the new page → Duplicate.
  await page.getByRole("treeitem", { name: new RegExp(unique) }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  // The editor navigates to the clone, whose name carries "(copy)".
  await expect(nameInput).toHaveValue(`${unique} (copy)`, { timeout: 10_000 });
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
  // Confirm the route landed and the settings shell mounted BEFORE asserting
  // panel content — this splits "navigation missed" from "panel didn't render".
  // Assertions inherit the project's CI expect timeout (15s, tuned for
  // post-navigation render lag under load); a hardcoded shorter timeout here
  // used to undercut that global and flake on the first heading after nav.
  await expect(page).toHaveURL(/\/settings/);
  await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
  // Default tab = Content types.
  await expect(page.getByRole("heading", { name: "Content types" }).first()).toBeVisible();
  // Each section is a tab in the left nav; clicking it shows that section.
  for (const tab of ["Users & roles", "API keys", "Webhooks", "Trash", "Audit log", "Your account", "Languages"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(page.getByRole("heading", { name: tab }).first()).toBeVisible();
  }
  await page.screenshot({ path: `${SHOT}/08-admin-panels.png` });
});

test("content-type editor offers the new field types (datetime, select, link)", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Settings" }).click();
  // Let the Settings panel finish mounting before interacting — ContentTypesPanel
  // re-renders as its data queries resolve, which can detach the action button
  // mid-click under CI load. Wait for the (static) panel heading first.
  await expect(page.getByRole("heading", { name: "Content types" }).first()).toBeVisible();
  await page.getByRole("button", { name: "New content type" }).click();
  // The template gallery opens first — this test needs the blank editor.
  await page.getByRole("dialog").getByRole("button", { name: "Start blank" }).click();
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
  await expect(area).toContainText(/drag in a shared block/i);
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
  // The row appears immediately; the image field is inside it, so open it.
  await expect(area.getByText("Hero", { exact: false }).first()).toBeVisible({ timeout: 10_000 });
  await openBlock(area);
  await expect(area.getByText(/Image not found/)).toBeVisible();

  // Cleanup: trash the throwaway page.
  await page.getByRole("treeitem", { name: new RegExp(unique) }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
});

test("an image dropped on a block's image field uploads ONCE (no duplicate asset, no extra block)", async ({ page }) => {
  // Regression: nested drop zones (image field / richtext INSIDE a content
  // area) called preventDefault but not stopPropagation — the native event
  // bubbled to the content area's drop handler, which uploaded the SAME file
  // again (different generated name) and auto-created an image block.
  await login(page);
  const unique = `DupDrop-${Date.now().toString(36)}`;
  await page.getByRole("button", { name: "Create new content" }).click();
  const dlg = page.getByRole("dialog", { name: "Create content" });
  await dlg.getByLabel("Name").fill(unique);
  await dlg.getByRole("button", { name: "Create", exact: true }).click();
  await expect(editorName(page)).toHaveValue(unique, { timeout: 10000 });

  // An inline Hero block — its image field sits INSIDE the content area.
  await addBlock(page, "Hero");
  const area = page.getByTestId("content-area-mainArea");
  await openBlock(area);
  await expect(area.getByRole("button", { name: "Choose image" }).first()).toBeVisible();

  const mediaCount = async () => {
    await page.getByRole("tab", { name: "Media" }).click();
    // The count label renders "0 images" while the assets query loads — wait
    // until two consecutive reads agree before trusting it.
    const read = async () => Number((await page.getByRole("tab", { name: /^\d+ images?$/ }).textContent())?.match(/\d+/)?.[0] ?? Number.NaN);
    let prev = await read();
    for (let i = 0; i < 20; i += 1) {
      await page.waitForTimeout(400);
      const next = await read();
      if (next === prev && Number.isFinite(next)) return next;
      prev = next;
    }
    return prev;
  };
  const before = await mediaCount();

  // Drop a real 1×1 PNG on the image field (dispatched with bubbles, like a
  // genuine OS drop).
  await area.getByRole("button", { name: "Choose image" }).first().evaluate((target) => {
    const bytes = atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) arr[i] = bytes.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([arr], "dup-check.png", { type: "image/png" }));
    const fire = (t: string) => target.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
    fire("dragenter");
    fire("dragover");
    fire("drop");
  });

  // The field fills (the upload landed)…
  await expect(area.getByRole("button", { name: "Replace" }).first()).toBeVisible({ timeout: 15_000 });
  // …allow any buggy second upload to land too, then count.
  await page.waitForTimeout(2000);
  expect(await mediaCount()).toBe(before + 1);
  // No extra auto-created block: the area still holds exactly the Hero.
  await expect(area.getByRole("listitem")).toHaveCount(1);

  // Cleanup: trash the throwaway page.
  await page.getByRole("treeitem", { name: new RegExp(unique) }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
});

test("dragging an EXISTING library image onto an image field references it — no duplicate (reported: stock image, dragged in, became two)", async ({ page }) => {
  // Repro: a library/stock thumbnail's native <img> drag tags the image along
  // in dataTransfer.files AND carries the app's x-paperboy {kind:media} payload.
  // The drop handler used to take the file path first → re-upload → a second
  // copy in the media pane. It must prefer the in-app reference.
  await login(page);
  const unique = `RefDrop-${Date.now().toString(36)}`;
  await page.getByRole("button", { name: "Create new content" }).click();
  const dlg = page.getByRole("dialog", { name: "Create content" });
  await dlg.getByLabel("Name").fill(unique);
  await dlg.getByRole("button", { name: "Create", exact: true }).click();
  await expect(editorName(page)).toHaveValue(unique, { timeout: 10000 });
  await addBlock(page, "Hero");
  const area = page.getByTestId("content-area-mainArea");
  await openBlock(area);
  await expect(area.getByRole("button", { name: "Choose image" }).first()).toBeVisible();

  // Upload exactly one real asset to reference (page context → session cookie).
  const assetId = await page.evaluate(async () => {
    const csrf = await (await fetch("/api/v1/auth/me", { credentials: "include" })).json();
    const bytes = atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) arr[i] = bytes.charCodeAt(i);
    const fd = new FormData();
    fd.append("file", new File([arr], "library-original.png", { type: "image/png" }));
    const r = await fetch("/api/v1/manage/assets", { method: "POST", body: fd, credentials: "include", headers: { "x-csrf-token": csrf.csrfToken } });
    return (await r.json()).documentId as string;
  });
  expect(assetId).toBeTruthy();

  const mediaCount = async () => {
    await page.getByRole("tab", { name: "Media" }).click();
    const read = async () => Number((await page.getByRole("tab", { name: /^\d+ images?$/ }).textContent())?.match(/\d+/)?.[0] ?? Number.NaN);
    let prev = await read();
    for (let i = 0; i < 20; i += 1) {
      await page.waitForTimeout(400);
      const next = await read();
      if (next === prev && Number.isFinite(next)) return next;
      prev = next;
    }
    return prev;
  };
  const before = await mediaCount();

  // Drop carrying BOTH the in-app reference AND a tag-along file (the exact
  // shape a native image drag produces). The reference must win.
  await area.getByRole("button", { name: "Choose image" }).first().evaluate((target, id) => {
    const bytes = atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) arr[i] = bytes.charCodeAt(i);
    const dt = new DataTransfer();
    dt.setData("application/x-paperboy", JSON.stringify({ kind: "media", documentId: id, url: "/api/v1/media/library-original.png", alt: "" }));
    dt.items.add(new File([arr], "tagalong.png", { type: "image/png" })); // native <img> drag adds this
    const fire = (t: string) => target.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
    fire("dragenter");
    fire("dragover");
    fire("drop");
  }, assetId);

  // Field fills (now referencing the existing asset)…
  await expect(area.getByRole("button", { name: "Replace" }).first()).toBeVisible({ timeout: 15_000 });
  // …and crucially NO new asset was uploaded: count is unchanged.
  await page.waitForTimeout(2000);
  expect(await mediaCount()).toBe(before);

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

test("block card header controls stay inside the card in a narrow form column", async ({ page }) => {
  await login(page);
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(editorName(page)).toHaveValue("Home");
  // Side by side squeezes the form into a narrow column; drag the form|preview
  // divider to its far-left minimum — the narrowest legal layout. The block card
  // header (title + display select + move/remove) must wrap, not paint outside
  // the card (reported live 2026-08-21: chevrons + trash spilling into the pane).
  await page.getByRole("button", { name: "Side by side" }).click();
  const handle = page.getByRole("separator").last();
  const hb = await handle.boundingBox();
  if (hb) {
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x - 600, hb.y + hb.height / 2, { steps: 10 });
    await page.mouse.up();
  }
  const card = page.locator('[id^="pb-block-"]').first();
  await card.scrollIntoViewIfNeeded();
  // Row actions live behind one overflow trigger; it is the rightmost control,
  // so it is the one that would paint outside a narrow card.
  const actions = card.getByRole("button", { name: /^Actions for / }).first();
  const cardBox = (await card.boundingBox())!;
  const btnBox = (await actions.boundingBox())!;
  expect(btnBox.x + btnBox.width, "Row actions must not overflow their block row").toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
});

/**
 * Add a block the way an editor does: open the area's "Add block" menu and pick
 * a type. (It used to be one chip per type sitting above the area — seventeen of
 * them on a normal page.) The menu is portalled to the body, so the item is
 * looked up on the page even when the trigger is scoped to one area.
 */
async function addBlock(page: Page, name: string, scope?: Locator) {
  await (scope ?? page).getByRole("button", { name: "Add block" }).first().click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

/**
 * Open a block row so its fields are on screen.
 *
 * A content area lists blocks as compact rows and only the open one shows its
 * fields, so a test that fills a block field has to open it first — the same
 * click an editor makes. Idempotent: already-open rows are left alone.
 */
async function openBlock(scope: Page | Locator, index = 0) {
  const row = scope.locator(`li#pb-block-${index}`);
  // :not([aria-haspopup]) — the row's overflow menu is a Radix trigger, which
  // carries aria-expanded as well. The disclosure is the one that expands
  // without opening a popup.
  const toggle = row.locator("> div > button[aria-expanded]:not([aria-haspopup])");
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  return row;
}

/** The preview iframe (the web app on :8092) — polls because it mounts lazily. */
async function waitPreviewFrame(page: Page) {
  for (let i = 0; i < 40; i++) {
    const f = page.frames().find((fr) => /:8092(\/|$)/.test(fr.url()));
    if (f) return f;
    await page.waitForTimeout(250);
  }
  throw new Error(`preview iframe never appeared; frames: ${page.frames().map((f) => f.url()).join(", ")}`);
}

test("visual editing: a preview 'edit' message switches tab + focuses the field/block", async ({ page }) => {
  await login(page);
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(editorName(page)).toHaveValue("Home");

  // The message must come FROM THE PREVIEW IFRAME. The editor's handler now checks
  // event.origin against the configured preview origin, because `paperboy:drop`
  // appends a block and lets autosave commit it — an unvalidated handler is a write
  // primitive that any page which window.open()s the admin could drive, with CSRF
  // unable to see it. So this posts from inside the iframe (origin = the web app,
  // source = the iframe window), exactly as @paperboycms/preview does. Posting from
  // the admin page itself is now correctly ignored, which is the point.
  await page.getByRole("button", { name: "Side by side" }).click();
  const previewFrame = await waitPreviewFrame(page);

  // SEO meta title → switches to the SEO tab and focuses the field.
  await previewFrame.evaluate(() => window.parent.postMessage({ type: "paperboy:edit", field: "metaTitle" }, "*"));
  await expect(page.locator("#f-metaTitle")).toBeFocused({ timeout: 5000 });

  // A block click scrolls to that block row in the content area.
  await previewFrame.evaluate(() =>
    window.parent.postMessage({ type: "paperboy:edit", field: "mainArea", blockIndex: 0 }, "*"),
  );
  await expect(page.locator("#pb-block-0")).toBeVisible({ timeout: 5000 });
});

test("visual editing: a field INSIDE a block opens the on-page overlay scoped to that block", async ({ page }) => {
  await login(page);
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(editorName(page)).toHaveValue("Home");
  // On-page mode: clicking a tagged field inside a rendered block must open the
  // in-place overlay for THAT block's field — not bail out to the side-by-side
  // form (reported live 2026-08-21: hero text only ever opened the block card).
  await page.getByRole("button", { name: "On-page" }).click();
  const frame = await waitPreviewFrame(page);
  await frame.evaluate(() =>
    window.parent.postMessage(
      { type: "paperboy:edit", field: "title", blockIndex: 0, blockType: "HeroBlock", rect: { x: 40, y: 40, w: 240, h: 28 }, click: { x: 60, y: 54 } },
      "*",
    ),
  );
  await expect(page.getByText("Edit on page")).toBeVisible({ timeout: 5000 });
  // The overlay edits the BLOCK's own field (HeroBlock.title); the form panel
  // stays unmounted — dropping to side-by-side would render #pb-block-0.
  await expect(page.getByRole("textbox", { name: "Title" })).toBeVisible();
  await expect(page.locator("#pb-block-0")).toHaveCount(0);
});

test("focusing a block field in the form highlights that block's field in the preview", async ({ page }) => {
  await login(page);
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(editorName(page)).toHaveValue("Home");
  await page.getByRole("button", { name: "Side by side" }).click();
  const frame = await waitPreviewFrame(page);
  await frame.locator("body.pb-editing").waitFor({ state: "attached", timeout: 20_000 });
  // Focus the HERO block's Title editor in the form (block row, area index 0).
  // The field lives inside the row, so open it first — which is also what a
  // preview click does on the way in.
  await openBlock(page);
  await page.locator("#bf-h1-title").click();
  // paperboy:focus carries the block index, so the flash lands on THAT block's
  // field in the page — not on the first same-named field or the whole area.
  await expect(frame.locator('[data-pb-block-index="0"] [data-pb-field="title"]')).toHaveClass(/pb-focus/, { timeout: 3000 });
});

test("the 'no bridge' hint never appears for a frontend that runs the bridge", async ({ page }) => {
  await login(page);
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(editorName(page)).toHaveValue("Home");
  await page.getByRole("button", { name: "Side by side" }).click();
  const frame = await waitPreviewFrame(page);
  await frame.locator("body.pb-editing").waitFor({ state: "attached", timeout: 20_000 });
  const hint = page.getByText("No response from the preview bridge");
  // The hint appears 4s after a reset with no bridge activity. Switching device
  // and locale re-runs that reset — with only the one-shot init announcement to
  // go on, the admin went deaf and accused a working frontend. The ping/pong
  // liveness probe must keep it silent through all of it.
  await expect(hint).toHaveCount(0);
  for (const device of ["tablet", "mobile", "desktop"]) {
    await page.getByRole("button", { name: new RegExp(`^${device}$`, "i") }).click();
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(5000);
  await expect(hint).toHaveCount(0);
});

test("on-page edit of a block field called 'name' edits the BLOCK, not the page title", async ({ page }) => {
  await login(page);
  // "name" is the page-title convention in the on-page overlay, but it is also a
  // perfectly ordinary field name for a block — a hero that renders a person's
  // name, for instance. Clicking it used to open the PAGE title input, showing
  // "Home" where the editor expected the person (reported live 2026-08-23).
  const me = await page.request.get("/api/v1/auth/me");
  const csrf = ((await me.json()) as { csrfToken: string }).csrfToken;
  const headers = { "x-csrf-token": csrf, origin: "http://localhost:8090" };

  // Give the hero block its own `name` field (additive, optional).
  const heroRes = await page.request.get("/api/v1/manage/content-types/HeroBlock");
  const hero = (await heroRes.json()) as { fields: { name: string }[]; [k: string]: unknown };
  if (!hero.fields.some((f) => f.name === "name")) {
    const put = await page.request.put("/api/v1/manage/content-types/HeroBlock", {
      headers,
      data: {
        ...hero,
        fields: [
          ...hero.fields,
          { name: "name", displayName: "Person name", type: "text", delivery: "public", helpText: "The person's name." },
        ],
      },
    });
    expect(put.ok(), `add name field: ${put.status()} ${await put.text()}`).toBe(true);
  }

  // Fill it on the Home page's existing hero block.
  const tree = await page.request.get("/api/v1/manage/content/tree");
  const home = ((await tree.json()) as { documentId: string; name: string }[]).find((n) => /Home/.test(n.name))!;
  const current = await page.request.get(`/api/v1/manage/content/${home.documentId}?locale=en`);
  const data = ((await current.json()) as { data: Record<string, unknown> }).data;
  const area = (Array.isArray(data.mainArea) ? data.mainArea : []) as { blockType: string; inline: Record<string, unknown> | null }[];
  const heroIndex = area.findIndex((b) => b.blockType === "HeroBlock" && b.inline !== null);
  expect(heroIndex, "the seeded Home page has an inline hero block").toBeGreaterThanOrEqual(0);
  const save = await page.request.put(`/api/v1/manage/content/${home.documentId}?locale=en`, {
    headers,
    data: {
      data: {
        ...data,
        mainArea: area.map((b, i) => (i === heroIndex ? { ...b, inline: { ...b.inline, name: "Hans Christian" } } : b)),
      },
    },
  });
  expect(save.ok(), `save hero name: ${save.status()} ${await save.text()}`).toBe(true);

  // The SPA cached the content types before this test changed them.
  await page.reload();
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(editorName(page)).toHaveValue("Home");
  await page.getByRole("button", { name: "On-page" }).click();
  const frame = await waitPreviewFrame(page);
  await frame.locator("body.pb-editing").waitFor({ state: "attached", timeout: 20_000 });

  await frame.evaluate(
    (i) =>
      window.parent.postMessage(
        { type: "paperboy:edit", field: "name", blockIndex: i, blockType: "HeroBlock", rect: { x: 30, y: 30, w: 200, h: 24 }, click: { x: 40, y: 40 } },
        "*",
      ),
    heroIndex,
  );

  await expect(page.getByText("Edit on page")).toBeVisible({ timeout: 5000 });
  // The overlay must hold the BLOCK's value. The page title here would mean the
  // page-name convention swallowed a legitimate block field.
  const input = page.getByRole("textbox", { name: "Person name" });
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("Hans Christian");

  // Put HeroBlock back. Leaving the extra field behind makes a RE-RUN of the
  // earlier tests ambiguous on "Name" ("Person name" also matches), which is
  // invisible in CI's fresh database and bites every local repeat run.
  await page.request.put("/api/v1/manage/content-types/HeroBlock", {
    headers,
    data: { ...hero, fields: hero.fields.filter((f) => f.name !== "name") },
  });
});

test("building a form: the key fills itself in from the label, and a clash is called out", async ({ page }) => {
  await login(page);
  // The field key is an identifier the answer is stored under — the one
  // genuinely technical thing in building a form. An editor should get it for
  // free from the label they already typed, and be TOLD when two fields collide:
  // formSpecFrom keeps the first, so the second silently never reaches visitors.
  const me = await page.request.get("/api/v1/auth/me");
  const csrf = ((await me.json()) as { csrfToken: string }).csrfToken;
  const headers = { "x-csrf-token": csrf, origin: "http://localhost:8090" };

  // The Form block plus the field blocks its area allow-lists.
  const inst = await page.request.post("/api/v1/manage/type-templates/Form/instantiate", {
    headers,
    data: { withBlocks: true, updateExisting: true },
  });
  expect(inst.ok(), `instantiate Form: ${inst.status()} ${await inst.text()}`).toBe(true);

  const created = await page.request.post("/api/v1/manage/content", {
    headers,
    data: { type: "Form", parentId: null, locale: "en", name: `E2E form ${Date.now()}` },
  });
  expect(created.ok(), `create form: ${created.status()} ${await created.text()}`).toBe(true);
  const { documentId } = (await created.json()) as { documentId: string };

  // The SPA cached the content types before this test created them.
  await page.goto(`/edit/${documentId}`);
  await page.reload();
  const area = page.getByTestId("content-area-fields");
  await expect(area).toBeVisible({ timeout: 20_000 });

  // Two questions, added the way an editor adds them.
  await addBlock(page, "Text field", area);
  await addBlock(page, "Email field", area);

  // The LABEL comes first on a form field — the key is derived from it, so it
  // has no business being the first thing an editor meets.
  const first = await openBlock(area, 0);
  await expect(first.getByRole("textbox").first()).toHaveAttribute("aria-label", "Label");

  // Type the label, leave the field: the key appears by itself.
  const firstKey = first.getByRole("textbox", { name: "Field key" });
  await expect(firstKey).toHaveValue("");
  await first.getByRole("textbox", { name: "Label" }).fill("Company name");
  await first.getByRole("textbox", { name: "Label" }).blur();
  await expect(firstKey).toHaveValue("companyName");

  // A key the editor typed themselves is never overwritten by a later label edit —
  // stored answers are keyed by it.
  await firstKey.fill("firm");
  await first.getByRole("textbox", { name: "Label" }).fill("Company or organisation");
  await first.getByRole("textbox", { name: "Label" }).blur();
  await expect(firstKey).toHaveValue("firm");

  // Second field, same key: both ROWS say so, because either could be the
  // mistake — and on the row you can see which two clash without opening either.
  const second = await openBlock(area, 1);
  const clash = area.getByText("duplicate key");
  await expect(clash).toHaveCount(0);
  await second.getByRole("textbox", { name: "Field key" }).fill("firm");
  await expect(first.getByText("duplicate key")).toBeVisible();
  await expect(second.getByText("duplicate key")).toBeVisible();

  // Resolved by giving it its own key.
  await second.getByRole("textbox", { name: "Field key" }).fill("email");
  await expect(clash).toHaveCount(0);

  // Clean up: this test creates a shared block at the root.
  const del = await page.request.delete(`/api/v1/manage/content/${documentId}`, { headers });
  expect(del.ok(), `delete form: ${del.status()}`).toBe(true);
});

test("the existing-block picker searches, and never offers a block the area forbids", async ({ page }) => {
  await login(page);
  // A shared block belongs to no page — it can be reused in any area that allows
  // its type. The picker is how that is reached. It must not list a block this
  // area rejects: allowedBlocks is enforced when the write lands, so offering one
  // only buys a validation error a few clicks later.
  const me = await page.request.get("/api/v1/auth/me");
  const csrf = ((await me.json()) as { csrfToken: string }).csrfToken;
  const headers = { "x-csrf-token": csrf, origin: "http://localhost:8090" };

  const inst = await page.request.post("/api/v1/manage/type-templates/Form/instantiate", {
    headers,
    data: { withBlocks: true, updateExisting: true },
  });
  expect(inst.ok(), `instantiate Form: ${inst.status()}`).toBe(true);

  // A shared block whose type the Form's `fields` area does NOT allow.
  const outsider = await page.request.post("/api/v1/manage/content", {
    headers,
    data: { type: "CardBlock", parentId: null, locale: "en", name: `Picker outsider ${Date.now()}` },
  });
  expect(outsider.ok(), `create CardBlock: ${outsider.status()} ${await outsider.text()}`).toBe(true);
  const outsiderDoc = (await outsider.json()) as { documentId: string; name: string };
  const outsiderName = outsiderDoc.name;

  const created = await page.request.post("/api/v1/manage/content", {
    headers,
    data: { type: "Form", parentId: null, locale: "en", name: `Picker form ${Date.now()}` },
  });
  const formDoc = (await created.json()) as { documentId: string };

  await page.goto(`/edit/${formDoc.documentId}`);
  await page.reload();
  await expect(page.getByTestId("content-area-fields")).toBeVisible({ timeout: 20_000 });

  // Reuse lives in the Add block menu now, beside the types you can create.
  await page.getByRole("button", { name: "Add block" }).first().click();
  await page.getByRole("menuitem", { name: /^Existing block/ }).click();
  const picker = page.getByRole("dialog", { name: "Insert an existing block" });
  await expect(picker).toBeVisible();

  // The CardBlock is a shared block, but not one this area accepts.
  await expect(picker.getByText(outsiderName)).toHaveCount(0);
  // ...and the editor is told, rather than left hunting for it.
  await expect(picker.getByText(/not allowed in this area/)).toBeVisible();

  // Search narrows what IS offered. Pages are placeable anywhere (as teasers).
  await picker.getByRole("searchbox", { name: "Search blocks and pages" }).fill("home");
  await expect(picker.getByText("Pages (as teaser)")).toBeVisible();
  await picker.getByRole("searchbox", { name: "Search blocks and pages" }).fill("zzz-no-such-block");
  await expect(picker.getByText(/Nothing matches/)).toBeVisible();

  // Escape closes it.
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);

  for (const id of [formDoc.documentId, outsiderDoc.documentId]) {
    await page.request.delete(`/api/v1/manage/content/${id}`, { headers });
  }
});

test("an area that allows ANY block still does not offer parts (a form's field blocks)", async ({ page }) => {
  await login(page);
  // "Any block" must not mean "including the ten field blocks of a Form".
  // A Date field has no meaning outside the Form that compiles it into a spec,
  // yet an area with no allow-list offered all ten beside real page blocks.
  const me = await page.request.get("/api/v1/auth/me");
  const csrf = ((await me.json()) as { csrfToken: string }).csrfToken;
  const headers = { "x-csrf-token": csrf, origin: "http://localhost:8090" };

  const inst = await page.request.post("/api/v1/manage/type-templates/Form/instantiate", {
    headers,
    data: { withBlocks: true, updateExisting: true },
  });
  expect(inst.ok(), `instantiate Form: ${inst.status()}`).toBe(true);

  // A page type whose area declares NO allowedBlocks — the "any block" case.
  const typeName = "PartsProbePage";
  await page.request.put(`/api/v1/manage/content-types/${typeName}`, {
    headers,
    data: {
      name: typeName,
      displayName: "Parts probe page",
      kind: "page",
      fields: [{ name: "openArea", displayName: "Open area", type: "contentArea", delivery: "public", allowedBlocks: [] }],
    },
  }).catch(() => undefined);
  const createType = await page.request.post("/api/v1/manage/content-types", {
    headers,
    data: {
      name: typeName,
      displayName: "Parts probe page",
      kind: "page",
      fields: [{ name: "openArea", displayName: "Open area", type: "contentArea", delivery: "public", allowedBlocks: [] }],
    },
  });
  expect([200, 409]).toContain(createType.status());

  const created = await page.request.post("/api/v1/manage/content", {
    headers,
    data: { type: typeName, parentId: null, locale: "en", name: `Parts probe ${Date.now()}` },
  });
  expect(created.ok(), `create page: ${created.status()} ${await created.text()}`).toBe(true);
  const doc = (await created.json()) as { documentId: string };

  await page.goto(`/edit/${doc.documentId}`);
  await page.reload();
  // Wait for the editor to SETTLE before opening the menu. The old assertion on
  // an always-rendered chip row did this implicitly; a menu is transient, so a
  // re-render arriving mid-click (a query resolving after the reload) closes it
  // again and the palette is simply not there.
  const openArea = page.getByTestId("content-area-openArea");
  await expect(openArea).toBeVisible({ timeout: 20_000 });

  await openArea.getByRole("button", { name: "Add block" }).click();
  const palette = page.getByLabel("Block palette");
  await expect(palette).toBeVisible({ timeout: 20_000 });

  // Populated with real page blocks…
  await expect(palette.getByRole("menuitem", { name: "Hero", exact: true })).toBeVisible();
  // …and free of the parts.
  // The form fields, and the three composition parts that used to leak into the
  // page-level list — an "Accordion item" chosen here renders as nothing.
  for (const part of [
    "Date field",
    "Number field",
    "Consent checkbox",
    "Explanatory text",
    "Accordion item",
    "Link item",
    "Question with answer",
  ]) {
    await expect(palette.getByRole("menuitem", { name: part, exact: true }), part).toHaveCount(0);
  }
  // The Form itself is real page composition and stays on offer.
  await expect(palette.getByRole("menuitem", { name: "Form", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.request.delete(`/api/v1/manage/content/${doc.documentId}`, { headers });
  await page.request.delete(`/api/v1/manage/content-types/${typeName}`, { headers });
});

test("a reference field offers what its allowedTypes say — including blocks", async ({ page }) => {
  await login(page);
  // The picker listed PAGES only, so a reference constrained to a block type
  // (a section pointing at a shared Form) had an empty dropdown reading
  // "choose a page" — the value could only be set through the API. It also
  // ignored allowedTypes, offering pages the write then rejects.
  const me = await page.request.get("/api/v1/auth/me");
  const csrf = ((await me.json()) as { csrfToken: string }).csrfToken;
  const headers = { "x-csrf-token": csrf, origin: "http://localhost:8090" };

  const inst = await page.request.post("/api/v1/manage/type-templates/Form/instantiate", {
    headers,
    data: { withBlocks: true, updateExisting: true },
  });
  expect(inst.ok(), `instantiate Form: ${inst.status()}`).toBe(true);

  const typeName = "RefProbePage";
  const def = {
    name: typeName,
    displayName: "Ref probe page",
    kind: "page",
    fields: [{ name: "pickedForm", displayName: "Picked form", type: "reference", delivery: "public", allowedTypes: ["Form"] }],
  };
  const createType = await page.request.post("/api/v1/manage/content-types", { headers, data: def });
  if (createType.status() === 409) {
    const put = await page.request.put(`/api/v1/manage/content-types/${typeName}`, { headers, data: def });
    expect(put.ok(), `update probe type: ${put.status()}`).toBe(true);
  } else {
    expect(createType.ok(), `create probe type: ${createType.status()} ${await createType.text()}`).toBe(true);
  }

  const formName = `Ref target form ${Date.now()}`;
  const form = await page.request.post("/api/v1/manage/content", {
    headers,
    data: { type: "Form", parentId: null, locale: "en", name: formName },
  });
  expect(form.ok(), `create form: ${form.status()}`).toBe(true);
  const formDoc = (await form.json()) as { documentId: string };

  const probe = await page.request.post("/api/v1/manage/content", {
    headers,
    data: { type: typeName, parentId: null, locale: "en", name: `Ref probe ${Date.now()}` },
  });
  const probeDoc = (await probe.json()) as { documentId: string };

  await page.goto(`/edit/${probeDoc.documentId}`);
  await page.reload();
  const picker = page.getByLabel("Picked form");
  await expect(picker).toBeVisible({ timeout: 20_000 });

  // The Form is offered…
  await expect(picker.locator("option", { hasText: formName })).toHaveCount(1);
  // …and pages are NOT, because allowedTypes says Form only.
  await expect(picker.locator("option", { hasText: "Home" })).toHaveCount(0);
  // The placeholder names what is being chosen, not "a page".
  await expect(picker.locator("option").first()).not.toHaveText(/choose a page/);

  // Picking it round-trips through a save.
  await picker.selectOption({ label: formName });
  const saved = await page.request.get(`/api/v1/manage/content/${probeDoc.documentId}?locale=en`);
  expect(saved.ok()).toBe(true);

  for (const id of [probeDoc.documentId, formDoc.documentId]) {
    await page.request.delete(`/api/v1/manage/content/${id}`, { headers });
  }
  await page.request.delete(`/api/v1/manage/content-types/${typeName}`, { headers });
});

test("the link editor picks a PAGE, so the link cannot rot", async ({ page }) => {
  await login(page);
  // A link field used to be one text box labelled "https://… or /path", which
  // made the most common case — pointing at a page — a hand-typed string that
  // breaks the moment someone renames a slug. It now stores the page's
  // documentId and delivery resolves the live path.
  const me = await page.request.get("/api/v1/auth/me");
  const csrf = ((await me.json()) as { csrfToken: string }).csrfToken;
  const headers = { "x-csrf-token": csrf, origin: "http://localhost:8090" };

  const typeName = "LinkGuiProbePage";
  const def = {
    name: typeName,
    displayName: "Link GUI probe",
    kind: "page",
    fields: [{ name: "cta", displayName: "Call to action", type: "link", delivery: "public" }],
  };
  const created = await page.request.post("/api/v1/manage/content-types", { headers, data: def });
  if (created.status() === 409) {
    expect((await page.request.put(`/api/v1/manage/content-types/${typeName}`, { headers, data: def })).ok()).toBe(true);
  } else {
    expect(created.ok(), `create type: ${created.status()} ${await created.text()}`).toBe(true);
  }

  const probe = await page.request.post("/api/v1/manage/content", {
    headers,
    data: { type: typeName, parentId: null, locale: "en", name: `Link GUI probe ${Date.now()}` },
  });
  const doc = (await probe.json()) as { documentId: string };

  await page.goto(`/edit/${doc.documentId}`);
  await page.reload();
  const modes = page.getByRole("radiogroup", { name: "Link type" });
  await expect(modes).toBeVisible({ timeout: 20_000 });

  // An empty link starts on Page — the option that cannot rot.
  await expect(modes.getByRole("radio", { name: "Page" })).toHaveAttribute("aria-checked", "true");

  // Pick a page by searching for it.
  // The field's <label for> names the control, so that is what it is called.
  await page.getByRole("button", { name: "Call to action" }).click();
  const picker = page.getByRole("dialog", { name: "Choose a page" });
  await picker.getByRole("searchbox", { name: "Search pages" }).fill("home");
  await picker.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByText("follows the page")).toBeVisible();

  // The editor autosaves on a debounce — wait for it before reading the API.
  await expect(page.getByText("All changes saved")).toBeVisible({ timeout: 15_000 });

  // It stored the IDENTITY, not a path.
  const saved = await page.request.get(`/api/v1/manage/content/${doc.documentId}?locale=en`);
  const cta = ((await saved.json()) as { data: { cta?: { documentId?: string; href?: string } } }).data.cta;
  expect(cta?.documentId, "the page's documentId is what got stored").toBeTruthy();
  expect(cta?.href ?? "").toBe("");

  // Switching to URL warns about a scheme the write chokepoint would reject,
  // before the save rather than after it.
  await modes.getByRole("radio", { name: "URL" }).click();
  await page.getByRole("textbox", { name: "Link URL" }).fill("javascript:alert(1)");
  await expect(page.getByText(/would run code in the visitor/)).toBeVisible();

  // Anchor mode builds the fragment for the editor.
  await modes.getByRole("radio", { name: "Anchor" }).click();
  await page.getByRole("textbox", { name: "Anchor on this page" }).fill("contact");
  await expect(page.getByText("#contact", { exact: false })).toBeVisible();

  await page.request.delete(`/api/v1/manage/content/${doc.documentId}`, { headers });
  await page.request.delete(`/api/v1/manage/content-types/${typeName}`, { headers });
});

test("clicking outside a property in on-page mode STAYS in on-page mode", async ({ page }) => {
  await login(page);
  // Reported 2026-08-23: "if i click outside a property in on page edit, it jumps
  // straight into side by side edit". A click on page background bubbles to the
  // nearest [data-pb-field], which is normally the content area wrapping the
  // blocks — and a content area is not editable in place, so the handler used to
  // fall through to setView("split") and yank the page away.
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(editorName(page)).toHaveValue("Home");
  await page.getByRole("button", { name: "On-page" }).click();
  const onpage = page.getByRole("button", { name: "On-page" });
  await expect(onpage).toHaveAttribute("aria-pressed", "true");

  const frame = await waitPreviewFrame(page);
  // The content area of the seeded Home page, as the bridge would report it.
  await frame.evaluate(() =>
    window.parent.postMessage(
      { type: "paperboy:edit", field: "mainArea", rect: { x: 40, y: 400, w: 600, h: 220 }, click: { x: 300, y: 500 } },
      "*",
    ),
  );
  await page.waitForTimeout(1200);

  // The mode the editor chose is still the mode they are in.
  await expect(onpage).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Side by side" })).toHaveAttribute("aria-pressed", "false");

  // And an editable field still opens its overlay, so nothing was broken to
  // achieve that.
  await frame.evaluate(() =>
    window.parent.postMessage(
      { type: "paperboy:edit", field: "heading", rect: { x: 40, y: 80, w: 400, h: 40 }, click: { x: 60, y: 90 } },
      "*",
    ),
  );
  await expect(page.getByText("Edit on page")).toBeVisible({ timeout: 5000 });
  await expect(onpage).toHaveAttribute("aria-pressed", "true");
});

test("Publish is inert when there is nothing to publish, and wakes up on a change", async ({ page }) => {
  await login(page);
  // Reported: a page with no pending changes shows the same full-emphasis
  // Publish button as one with changes. Worse than ambiguous — the API answers
  // "Nothing to publish (no draft changes)" with a 409, so it was a primary
  // button that could only produce an error toast.
  const me = await page.request.get("/api/v1/auth/me");
  const csrf = ((await me.json()) as { csrfToken: string }).csrfToken;
  const headers = { "x-csrf-token": csrf, origin: "http://localhost:8090" };

  const created = await page.request.post("/api/v1/manage/content", {
    headers,
    data: { type: "LandingPage", parentId: null, locale: "en", name: `Publish state ${Date.now()}` },
  });
  expect(created.ok(), `create: ${created.status()} ${await created.text()}`).toBe(true);
  const { documentId } = (await created.json()) as { documentId: string };

  // Fill the required field and publish, so the page is live with NO pending changes.
  const saved = await page.request.put(`/api/v1/manage/content/${documentId}?locale=en`, {
    headers,
    data: { data: { heading: "Nothing pending" } },
  });
  expect(saved.ok(), `save: ${saved.status()} ${await saved.text()}`).toBe(true);
  const published = await page.request.post(`/api/v1/manage/content/${documentId}/publish?locale=en`, { headers, data: {} });
  expect(published.ok(), `publish: ${published.status()} ${await published.text()}`).toBe(true);

  await page.goto(`/edit/${documentId}`);
  const publishBtn = page.getByRole("button", { name: "Publish", exact: true });
  await expect(publishBtn).toBeVisible({ timeout: 20_000 });

  // Up to date: the button must not invite a click the server will refuse.
  await expect(publishBtn).toBeDisabled();

  // Making a change wakes it up.
  const heading = page.locator("#f-heading");
  await expect(heading).toBeVisible();
  await heading.fill("Now there is something to publish");
  await expect(page.getByText("All changes saved")).toBeVisible({ timeout: 15_000 });
  await expect(publishBtn).toBeEnabled();

  await page.request.delete(`/api/v1/manage/content/${documentId}`, { headers });
});

test("visual editing: the admin IGNORES an edit message that is not from the preview origin", async ({ page }) => {
  await login(page);
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(editorName(page)).toHaveValue("Home");
  // Same payload as above, posted by the admin page to itself. Before the origin
  // check this focused the field; any page holding a window handle to the admin
  // could therefore drive the editor (including paperboy:drop, which writes).
  await page.evaluate(() => window.postMessage({ type: "paperboy:edit", field: "metaTitle" }, "*"));
  await page.waitForTimeout(1000);
  // A rejected message means the editor never switched to the SEO tab, so the field
  // is not rendered at all. Assert ABSENCE — `not.toBeFocused()` errors on a missing
  // element rather than passing, which is what made the first version of this fail.
  await expect(page.locator("#f-metaTitle")).toHaveCount(0);
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

test("copy desk can generate SEO meta from the page content", async ({ page }) => {
  await login(page);
  await page.getByRole("treeitem", { name: /Home/ }).click();
  await expect(editorName(page)).toHaveValue("Home");
  // exact: the richtext toolbar has its own "Copy desk (selection)" button.
  await page.getByRole("button", { name: "Copy desk", exact: true }).click();
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
