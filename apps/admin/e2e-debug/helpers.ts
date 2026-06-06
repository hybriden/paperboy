import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, expect } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIE_DIR = join(__dirname, ".auth");

/**
 * Shared helpers for the DEBUG suite. The login/session approach is copied from
 * the proven pattern in ../e2e/admin.spec.ts: authenticate once over the API,
 * cache the session cookie per email, and inject it into each context — the SPA
 * re-hydrates from /auth/me. This keeps us well under the login rate limit
 * (10 attempts/min/IP) even across dozens of tests.
 */

export const CREDENTIALS = {
  admin: { email: "admin@paperboy.test", password: "Admin!Passw0rd" },
  editor: { email: "editor@paperboy.test", password: "Editor!Passw0rd" },
  author: { email: "author@paperboy.test", password: "Author!Passw0rd" },
  viewer: { email: "viewer@paperboy.test", password: "Viewer!Passw0rd" },
} as const;

// One cached session cookie per email, shared across the whole worker AND
// persisted to disk so reruns/other files reuse it (the login rate limit is
// 10/min/IP — re-authenticating per test would trip it).
type Cookie = { name: string; value: string };
const sessionCache = new Map<string, Cookie>();

function diskCookie(email: string): Cookie | null {
  try {
    const f = join(COOKIE_DIR, `${email.replace(/[^a-z0-9]/gi, "_")}.json`);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, "utf8")) as Cookie;
  } catch {
    return null;
  }
}
function persistCookie(email: string, c: Cookie) {
  try {
    mkdirSync(COOKIE_DIR, { recursive: true });
    writeFileSync(join(COOKIE_DIR, `${email.replace(/[^a-z0-9]/gi, "_")}.json`), JSON.stringify(c));
  } catch {
    /* best effort */
  }
}

/** Authenticate via the API, retrying through the rate-limit window if needed. */
async function fetchCookie(page: Page, email: string, password: string): Promise<Cookie> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await page.request.post("/api/v1/auth/login", { data: { email, password } });
    if (res.ok()) {
      const setCookie = res
        .headersArray()
        .find((h) => h.name.toLowerCase() === "set-cookie" && h.value.includes("paperboy_sid"));
      if (!setCookie) throw new Error(`no session cookie in login response for ${email}`);
      const pair = setCookie.value.split(";")[0]!;
      const eq = pair.indexOf("=");
      return { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
    }
    lastStatus = res.status();
    if (lastStatus !== 429) throw new Error(`login failed for ${email}: ${lastStatus} ${await res.text()}`);
    // Rate-limited: wait out a slice of the 60s window, then retry.
    await page.waitForTimeout(8_000);
  }
  throw new Error(`login for ${email} stayed rate-limited (${lastStatus}) after retries`);
}

/**
 * Log in by injecting a cached session cookie (acquired once per email via the
 * API, persisted to disk). Lands on "/" with the account menu visible — proof
 * the SPA hydrated. If a cached cookie has expired, re-authenticate once.
 */
export async function login(page: Page, email = CREDENTIALS.admin.email, password = CREDENTIALS.admin.password) {
  let cookie = sessionCache.get(email) ?? diskCookie(email) ?? undefined;
  const applyCookie = async (c: Cookie) => {
    await page.context().addCookies([{ name: c.name, value: c.value, domain: "localhost", path: "/" }]);
  };
  // Validate a candidate cookie with a fast API call (not a slow SPA render).
  const valid = async (c: Cookie) => {
    await applyCookie(c);
    const me = await page.request.get("/api/v1/auth/me").catch(() => null);
    return !!me && me.ok();
  };

  if (!cookie || !(await valid(cookie))) {
    await page.context().clearCookies();
    cookie = await fetchCookie(page, email, password);
    sessionCache.set(email, cookie);
    persistCookie(email, cookie);
    await applyCookie(cookie);
  } else {
    sessionCache.set(email, cookie);
  }
  await page.goto("/");
  // SPA hydration can be slow under sustained full-suite load; one reload retry
  // covers a transient slow first paint without masking a real auth failure.
  const ok = await page
    .getByLabel("Account menu")
    .waitFor({ state: "visible", timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) {
    await page.reload();
    await expect(page.getByLabel("Account menu")).toBeVisible({ timeout: 20_000 });
  }
  // The editor view (props / split / on-page) persists in localStorage, so a
  // test that switched to on-page would hide the properties form for the next
  // one (cross-test state leak). Reset every login to the all-properties view.
  const view = await page.evaluate(() => localStorage.getItem("pb-editor-view"));
  if (view && view !== "props") {
    await page.evaluate(() => localStorage.setItem("pb-editor-view", "props"));
    await page.reload();
    await expect(page.getByLabel("Account menu")).toBeVisible({ timeout: 15_000 });
  }
}

/** A logged-in API request context (cookie + CSRF) for direct backend calls in tests. */
export async function apiSession(page: Page, email = CREDENTIALS.admin.email, password = CREDENTIALS.admin.password) {
  const res = await page.request.post("/api/v1/auth/login", { data: { email, password } });
  if (!res.ok()) throw new Error(`apiSession login failed for ${email}: ${res.status()}`);
  const body = (await res.json()) as { csrfToken: string };
  return { csrfToken: body.csrfToken };
}

/** Unique, human-scannable name so tests never collide on the shared dev DB. */
export function uniqueName(area: string): string {
  return `dbg-${area}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
}

/** Create a page through the tree's "New" dialog (UI path); returns the name.
 *  Use this when a test is specifically exercising the create-dialog flow. */
export async function createPageViaDialog(
  page: Page,
  opts: { area: string; type?: string } = { area: "page" },
): Promise<string> {
  const name = uniqueName(opts.area);
  await page.getByRole("button", { name: "Create new content" }).click();
  const dlg = page.getByRole("dialog", { name: "Create content" });
  await expect(dlg).toBeVisible();
  if (opts.type) await dlg.getByLabel("Content type").selectOption(opts.type);
  await dlg.getByLabel("Name").fill(name);
  await dlg.getByRole("button", { name: "Create", exact: true }).click();
  await expect(SEL.nameInput(page)).toHaveValue(name, { timeout: 15_000 });
  return name;
}

/**
 * Create a page via the API, then open it in the editor by URL. Deterministic
 * setup for tests whose SUBJECT is the editor (not the create dialog) — it
 * sidesteps a rare race where EditView's "redirect to start page" effect bounces
 * a freshly-created top-level page back to the start page mid-navigation.
 */
export async function createPage(
  page: Page,
  opts: { area: string; type?: string } = { area: "page" },
): Promise<string> {
  const name = uniqueName(opts.area);
  const type = opts.type ?? "ArticlePage";
  const me = await page.request.get("/api/v1/auth/me");
  if (!me.ok()) throw new Error(`createPage: not authenticated (${me.status()})`);
  const { csrfToken } = (await me.json()) as { csrfToken: string };
  // The management API enforces a same-origin check; page.request omits Origin,
  // so set it explicitly to the admin base URL.
  const origin = new URL(page.url() || "http://localhost:8090").origin;
  const res = await page.request.post("/api/v1/manage/content", {
    headers: { "x-csrf-token": csrfToken, origin },
    data: { type, parentId: null, locale: "en", name },
  });
  if (!res.ok()) throw new Error(`createPage: create failed ${res.status()} ${await res.text()}`);
  const { documentId } = (await res.json()) as { documentId: string };
  await page.goto(`/edit/${documentId}`);
  await expect(SEL.nameInput(page)).toHaveValue(name, { timeout: 15_000 });
  return name;
}

/**
 * Open the seeded Home page in the editor, robustly. Home is the start page, so
 * /edit with nothing selected auto-redirects to it — deterministic even when the
 * tree pane is slow to populate under full-suite load (clicking a tree row can
 * race the tree's render).
 */
export async function openHome(page: Page) {
  await page.goto("/edit");
  // The start-page redirect (/edit → /edit/<homeId>) is an effect that can race a
  // slow first render; one reload settles it without masking a real failure.
  const ok = await SEL.nameInput(page)
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(async () => (await SEL.nameInput(page).inputValue()) === "Home")
    .catch(() => false);
  if (!ok) await page.goto("/edit");
  await expect(SEL.nameInput(page)).toHaveValue("Home", { timeout: 20_000 });
}

/**
 * Wait for the editor's autosave to settle. The indicator transitions
 * idle → "Unsaved changes" → "Saving…" → "All changes saved". A naive "no
 * indicator or saved" poll can return on the PRE-edit idle frame (before React
 * has rendered the dirty state), so we first give the dirty/saving state a
 * chance to appear, then require it to reach "saved".
 */
export async function waitForSaved(page: Page) {
  const indicator = page.getByTestId("save-indicator");
  // Let the just-issued edit flip the indicator to a non-saved state first.
  await expect
    .poll(async () => ((await indicator.count()) ? (await indicator.textContent()) ?? "" : ""), { timeout: 3_000 })
    .toMatch(/Unsaved|Saving/)
    .catch(() => {
      /* edit may have already saved on a fast machine — fall through to the saved check */
    });
  await expect(indicator).toHaveText(/All changes saved/, { timeout: 15_000 });
}

/** Open the editor "Content actions" (⋯) menu. */
export async function openContentActions(page: Page) {
  await page.getByRole("button", { name: "Content actions" }).click();
}

/** Open the publish split-button's "More publish actions" menu. */
export async function openPublishMenu(page: Page) {
  await page.getByRole("button", { name: "More publish actions" }).click();
}

/** Go to a Settings section by its left-nav button label. */
export async function gotoSettings(page: Page, section: string) {
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: section, exact: true }).click();
}

/** A valid 1×1 transparent PNG (real magic bytes) for upload tests. */
export const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** Common selectors, centralised so a UI rename only needs one edit. */
export const SEL = {
  accountMenu: (page: Page) => page.getByLabel("Account menu"),
  // The editor's name field (aria-label, no <label htmlFor>) — distinct from the
  // create dialog's #cname (which also exposes the accessible name "Name").
  nameInput: (page: Page) => page.getByRole("textbox", { name: "Name", exact: true }).and(page.locator("[aria-label='Name']")),
  saveIndicator: (page: Page) => page.getByTestId("save-indicator"),
  publishBtn: (page: Page) => page.getByRole("button", { name: "Publish", exact: true }),
  // The workflow status chip: an inline-flex rounded-full pill carrying a status
  // dot + "Published" / "Published · changes" / "Draft".
  statusChip: (page: Page) =>
    page.locator("span.inline-flex.rounded-full").filter({ hasText: /Published|Draft/ }).first(),
  tree: (page: Page) => page.getByRole("tree", { name: "Content tree" }),
  treeItem: (page: Page, name: string | RegExp) =>
    page.getByRole("treeitem", { name: typeof name === "string" ? new RegExp(name) : name }),
  assetsPane: (page: Page) => page.getByRole("complementary").filter({ hasText: "Assets" }),
};

/** Trash a page by name from the tree context menu (cleanup-friendly). */
export async function trashFromTree(page: Page, name: string | RegExp) {
  const item = SEL.treeItem(page, name);
  if ((await item.count()) === 0) return;
  await item.first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
}

/** Capture browser console errors onto an array for assertions / debugging. */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}
