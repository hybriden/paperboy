import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

/**
 * A/B experiments in the admin (#125): set one up from a page's content area,
 * give version B a block, start it, see the area badge, pause, end with the
 * winner as a draft, and find it in Settings → Experiments and the dashboard.
 * Counts come in through the real public endpoint (POST /delivery/traffic).
 */

const run = Date.now().toString(36);
const PAGE = `AB page ${run}`;
const EXPERIMENT = `Hero test ${run}`;

async function signIn(page: Page): Promise<{ headers: Record<string, string> }> {
  const res = await page.request.post("/api/v1/auth/login", { data: { email: "admin@paperboy.test", password: "Admin!Passw0rd" } });
  expect(res.status(), await res.text()).toBe(200);
  await page.goto("/");
  await expect(page.getByLabel("Account menu")).toBeVisible({ timeout: 15_000 });
  const me = await page.request.get("/api/v1/auth/me");
  return { headers: { "x-csrf-token": ((await me.json()) as { csrfToken: string }).csrfToken, origin: new URL(page.url()).origin } };
}

async function axeClean(page: Page, context: string) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `${context}: ${JSON.stringify(serious.map((v) => v.id))}`).toEqual([]);
}

/** Visitors and conversions per version, reported the way a frontend does. */
async function count(request: APIRequestContext, key: string, experimentId: number, tally: Record<string, [number, number]>) {
  const exposures = Object.entries(tally).flatMap(([arm, [n]]) => Array.from({ length: n }, () => ({ experimentId, arm })));
  const conversions = Object.entries(tally).flatMap(([arm, [, c]]) => Array.from({ length: c }, () => ({ experimentId, arm, goal: "form" })));
  const res = await request.post("/api/v1/delivery/traffic", { headers: { authorization: `Bearer ${key}` }, data: { exposures, conversions } });
  expect(res.status(), await res.text()).toBe(202);
}

test("an editor runs an A/B experiment on a content area, end to end", async ({ page }) => {
  const { headers } = await signIn(page);
  // A published page of its own: version A is the page's PUBLISHED area.
  const created = await page.request.post("/api/v1/manage/content", { headers, data: { type: "LandingPage", parentId: null, locale: "en", name: PAGE } });
  expect(created.ok(), await created.text()).toBe(true);
  const documentId = ((await created.json()) as { documentId: string }).documentId;
  const put = await page.request.put(`/api/v1/manage/content/${documentId}?locale=en`, { headers, data: { data: { heading: "Original heading" } } });
  expect(put.ok(), await put.text()).toBe(true);
  const pub = await page.request.post(`/api/v1/manage/content/${documentId}/publish?locale=en`, { headers });
  expect(pub.ok(), await pub.text()).toBe(true);
  const keyRes = await page.request.post("/api/v1/manage/delivery-keys", { headers, data: { name: `ab-e2e-${run}`, type: "public" } });
  expect(keyRes.ok(), await keyRes.text()).toBe(true);
  const publicKey = ((await keyRes.json()) as { key: string }).key;

  // 1. Set it up from the area's header action.
  await page.goto(`/edit/${documentId}`);
  await expect(page.getByTestId("content-area-mainArea")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "A/B test this area" }).click();
  const panel = page.getByRole("dialog", { name: "A/B test: Main content area" });
  await expect(panel).toBeVisible();
  await panel.getByRole("textbox", { name: "Name" }).fill(EXPERIMENT);
  // A plan small enough to finish here: 50 % today, +100 % to detect → 16 per version.
  await panel.getByRole("spinbutton", { name: "Today’s conversion rate (%)" }).fill("50");
  await panel.getByRole("spinbutton", { name: "Smallest lift worth detecting (%)" }).fill("100");
  await expect(panel.getByText("Needs about 16 visitors per version")).toBeVisible();

  // 2. Version B gets a block, through the same area editor the page uses.
  const versionB = panel.getByRole("region", { name: "Version B" });
  await versionB.getByRole("button", { name: "Add block" }).click();
  await page.getByRole("menuitem", { name: "Card" }).click();
  await versionB.getByRole("textbox", { name: "Title" }).fill("Version B card");
  await panel.getByRole("button", { name: "Create experiment" }).click();
  const dialog = page.getByRole("dialog", { name: EXPERIMENT });
  await expect(dialog.getByRole("status").first()).toHaveText("Experiment draft");

  // Keyboard reachability: the plan's controls and the actions are tabbable.
  await dialog.getByRole("textbox", { name: "Name" }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("textbox", { name: /Hypothesis/ })).toBeFocused();
  const startButton = dialog.getByRole("button", { name: "Start", exact: true });
  for (let i = 0; i < 60 && !(await startButton.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(startButton).toBeFocused();
  await axeClean(page, "experiment panel");

  // 3. Start, with a confirmation that says what happens.
  await page.keyboard.press("Enter");
  const confirmStart = page.getByRole("dialog", { name: "Start the experiment?" });
  await expect(confirmStart).toContainText("Visitors to the live page are split");
  // Starting is deliberate but reversible: the primary button, not the red one.
  await expect(confirmStart.getByRole("button", { name: "Start experiment" })).toHaveClass(/btn-primary/);
  await confirmStart.getByRole("button", { name: "Start experiment" }).click();
  await expect(dialog.getByRole("status").first()).toHaveText("Experiment running · not conclusive");
  await expect(dialog.getByText("Pause it to edit.")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Name" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Close" }).click();

  // 4. The area badge and the publish menu.
  await expect(page.getByRole("button", { name: "Experiment running · not conclusive" })).toBeVisible();
  // Publishing mid-test changes version A: the editor says so first (#146).
  await page.getByRole("textbox", { name: "Heading" }).fill("Edited during the test");
  await expect(page.getByText("All changes saved").first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const warn = page.getByRole("dialog", { name: "Publish while an A/B test runs?" });
  await expect(warn).toContainText("Main content area");
  await warn.getByRole("button", { name: "Cancel" }).click();
  const stillLive = (await (await page.request.get(`/api/v1/delivery/content/${documentId}?locale=en`, { headers: { authorization: `Bearer ${publicKey}` } })).json()) as { data: { heading: string } };
  expect(stillLive.data.heading).toBe("Original heading");
  await page.getByRole("button", { name: "More publish actions" }).click();
  await page.getByRole("menuitem", { name: "View experiment" }).click();
  await expect(dialog).toBeVisible();

  // 5. Pause, then end: no winner is offered before the planned sample size.
  await dialog.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("dialog", { name: "Pause the experiment?" }).getByRole("button", { name: "Pause experiment" }).click();
  await expect(dialog.getByRole("status").first()).toHaveText("Experiment paused · not conclusive");
  await dialog.getByRole("button", { name: "End…" }).click();
  const end = page.getByRole("dialog", { name: "End the experiment?" });
  await expect(end.getByText("No winner can be chosen yet")).toBeVisible();
  await expect(end.getByRole("button", { name: "Winner as draft" })).toHaveCount(0);
  await end.getByRole("button", { name: "Cancel" }).click();

  // Counts arrive while it runs; then the verdict is complete and B leads.
  const list = await page.request.get(`/api/v1/manage/experiments?documentId=${documentId}`);
  const experimentId = ((await list.json()) as { id: number }[])[0]!.id;
  await dialog.getByRole("button", { name: "Resume" }).click();
  await page.getByRole("dialog", { name: "Resume the experiment?" }).getByRole("button", { name: "Resume experiment" }).click();
  await expect(dialog.getByRole("status").first()).toHaveText("Experiment running · not conclusive");
  await count(page.request, publicKey, experimentId, { a: [4, 1], b: [4, 2] });
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Experiment running · not conclusive" }).click();
  // 8 visitors since the start → 4 a day per version, 12 more each → 3 days.
  await expect(dialog.getByText("About 3 more days at the traffic so far (8 visitors a day).")).toBeVisible();
  await count(page.request, publicKey, experimentId, { a: [16, 3], b: [16, 16] });
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Experiment running · B leads · conclusive" })).toBeVisible({ timeout: 20_000 });

  // 6. End with the winner as a draft: B's block becomes the area's draft.
  await page.getByRole("button", { name: "Experiment running · B leads · conclusive" }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Version B converts better than A" })).toBeVisible();
  await dialog.getByRole("button", { name: "End…" }).click();
  await expect(end.getByRole("radio", { name: "Version B (leads)" })).toBeChecked();
  await end.getByRole("button", { name: "Winner as draft" }).click();
  await expect(dialog.getByRole("status").first()).toHaveText("Experiment ended");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("content-area-mainArea")).toContainText("Version B card");
  await expect(page.getByRole("button", { name: "A/B test this area" })).toBeVisible();

  // 7. Settings → Experiments lists it, filtered and searched.
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Experiments", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search experiments" }).fill(run);
  await page.getByRole("button", { name: /^Ended/ }).click();
  await expect(page.getByRole("button", { name: new RegExp(EXPERIMENT) })).toBeVisible();
  await page.getByRole("button", { name: /^Running/ }).click();
  await expect(page.getByRole("button", { name: new RegExp(EXPERIMENT) })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Cookieless (default)" })).toBeChecked();
  await axeClean(page, "settings experiments");
});

test("the dashboard lists running experiments", async ({ page }) => {
  const { headers } = await signIn(page);
  const created = await page.request.post("/api/v1/manage/content", { headers, data: { type: "LandingPage", parentId: null, locale: "en", name: `${PAGE} dash` } });
  const documentId = ((await created.json()) as { documentId: string }).documentId;
  await page.request.put(`/api/v1/manage/content/${documentId}?locale=en`, { headers, data: { data: { heading: "Dash" } } });
  expect((await page.request.post(`/api/v1/manage/content/${documentId}/publish?locale=en`, { headers })).ok()).toBe(true);
  const exp = await page.request.post("/api/v1/manage/experiments", {
    headers,
    data: { documentId, locale: "en", area: "mainArea", name: `Dash test ${run}`, arms: [{ key: "b", blocks: [] }] },
  });
  expect(exp.ok(), await exp.text()).toBe(true);
  const id = ((await exp.json()) as { id: number }).id;
  expect((await page.request.post(`/api/v1/manage/experiments/${id}/start`, { headers })).ok()).toBe(true);

  await page.goto("/dashboard");
  const row = page.getByRole("button", { name: new RegExp(`Dash test ${run}`) });
  await expect(row).toContainText("Experiment running · not conclusive");
  await row.click();
  const dialog = page.getByRole("dialog", { name: `Dash test ${run}` });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole("button", { name: "Close" }).click();

  // The preview's version picker forces version B in the framed page.
  await page.getByRole("button", { name: "Side by side" }).click();
  await page.getByRole("combobox", { name: "Preview version" }).selectOption(`${id}:b`);
  await expect(page.getByText("On-page editing is off: edit version B in the experiment panel.")).toBeVisible();
  await expect(page.locator("iframe").first()).toHaveAttribute("src", new RegExp(`pbab=${id}%3Ab`), { timeout: 20_000 });
  await page.request.post(`/api/v1/manage/experiments/${id}/end`, { headers, data: {} });
});

test("ending with a winner first saves the edits still pending in the editor (#146)", async ({ page }) => {
  const { headers } = await signIn(page);
  const created = await page.request.post("/api/v1/manage/content", { headers, data: { type: "LandingPage", parentId: null, locale: "en", name: `AB flush ${run}` } });
  const documentId = ((await created.json()) as { documentId: string }).documentId;
  await page.request.put(`/api/v1/manage/content/${documentId}?locale=en`, { headers, data: { data: { heading: "Before" } } });
  await page.request.post(`/api/v1/manage/content/${documentId}/publish?locale=en`, { headers });
  const card = { key: "kb", blockType: "CardBlock", display: "automatic", inline: { title: "Flush B card" }, ref: null };
  const exp = await page.request.post("/api/v1/manage/experiments", { headers, data: { documentId, locale: "en", area: "mainArea", name: `Flush ${run}`, baselineRate: 0.5, mde: 1, arms: [{ blocks: [card] }] } });
  expect(exp.ok(), await exp.text()).toBe(true);
  const experimentId = ((await exp.json()) as { id: number }).id;
  expect((await page.request.post(`/api/v1/manage/experiments/${experimentId}/start`, { headers })).ok()).toBe(true);
  const keyRes = await page.request.post("/api/v1/manage/delivery-keys", { headers, data: { name: `ab-flush-${run}`, type: "public" } });
  await count(page.request, ((await keyRes.json()) as { key: string }).key, experimentId, { a: [20, 4], b: [20, 18] });

  await page.goto(`/edit/${documentId}`);
  await expect(page.getByRole("button", { name: "Experiment running · B leads · conclusive" })).toBeVisible({ timeout: 20_000 });
  // Hold the editor's next save in flight, so it is still pending when End runs.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(`**/api/v1/manage/content/${documentId}?locale=en`, async (route) => {
    if (route.request().method() === "PUT") await held;
    await route.continue();
  });
  await page.getByRole("textbox", { name: "Heading" }).fill("Typed just before ending");
  await expect(page.getByText(/Saving/).first()).toBeVisible({ timeout: 5000 });
  await page.getByRole("button", { name: "Experiment running · B leads · conclusive" }).click();
  const dialog = page.getByRole("dialog", { name: `Flush ${run}` });
  await dialog.getByRole("button", { name: "End…" }).click();
  const end = page.getByRole("dialog", { name: "End the experiment?" });
  await end.getByRole("button", { name: "Winner as draft" }).click();
  setTimeout(release, 1500);
  await expect(dialog.getByRole("status").first()).toHaveText("Experiment ended", { timeout: 15_000 });
  await dialog.getByRole("button", { name: "Close" }).click();

  // Both survive: the heading typed before End, and the winner's block.
  await expect(page.getByText("Someone else changed this page")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Heading" })).toHaveValue("Typed just before ending");
  await expect(page.getByTestId("content-area-mainArea")).toContainText("Flush B card");
  const saved = (await (await page.request.get(`/api/v1/manage/content/${documentId}?locale=en`)).json()) as { data: { heading: string; mainArea: Array<{ inline: { title: string } }> } };
  expect(saved.data.heading).toBe("Typed just before ending");
  expect(saved.data.mainArea[0]!.inline.title).toBe("Flush B card");
});
