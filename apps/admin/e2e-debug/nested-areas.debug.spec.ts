import { expect, test } from "@playwright/test";
import { SEL, createPage, login, trashFromTree, waitForSaved } from "./helpers.js";

/**
 * NESTED CONTENT AREAS — a contentArea field INSIDE an inline block must render
 * as a full editable area (repeatable structures: FAQ topics → questions,
 * link lists, teaser lists). Regression pin: BlockField used to render NOTHING
 * for contentArea, so inline nested content was write-supported (coercion +
 * delivery recurse) but uneditable by humans.
 *
 * Uses the built-in template library end-to-end: FaqPage instantiated
 * withBlocks pulls in FaqTopicBlock + QuestionBlock.
 */

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("edit a question inside an inline FAQ topic (area-in-block), persisted across reload", async ({ page }) => {
  // Materialise the built-in FAQ set (idempotent on the shared dev DB:
  // updateExisting re-applies the template; withBlocks completes the block set).
  const me = await page.request.get("/api/v1/auth/me");
  const { csrfToken } = (await me.json()) as { csrfToken: string };
  const origin = new URL(page.url() || "http://localhost:8090").origin;
  const inst = await page.request.post("/api/v1/manage/type-templates/FaqPage/instantiate", {
    headers: { "x-csrf-token": csrfToken, origin },
    data: { updateExisting: true, withBlocks: true },
  });
  expect(inst.ok(), await inst.text()).toBe(true);

  const name = await createPage(page, { area: "nested", type: "FaqPage" });

  // Add an inline FAQ topic to the page's `topics` area…
  const topicsArea = page.getByTestId("content-area-topics");
  await page.getByRole("button", { name: "+ FAQ topic" }).click();
  await expect(topicsArea.getByLabel("Topic")).toBeVisible();
  await topicsArea.getByLabel("Topic").fill("General");

  // …and a question INSIDE the topic (the nested area — the regression target).
  const questionsArea = topicsArea.getByTestId("content-area-questions");
  await expect(questionsArea).toBeVisible();
  await topicsArea.getByRole("button", { name: "+ Question with answer" }).click();
  await expect(questionsArea.getByLabel("Question")).toBeVisible();
  await questionsArea.getByLabel("Question").fill("Is nested editing real?");
  await waitForSaved(page);

  // Survives a reload — the nested value was actually persisted, not just drawn.
  await page.reload();
  await expect(SEL.nameInput(page)).toHaveValue(name, { timeout: 15_000 });
  await expect(page.getByTestId("content-area-topics").getByLabel("Topic")).toHaveValue("General");
  await expect(page.getByTestId("content-area-questions").getByLabel("Question")).toHaveValue("Is nested editing real?");

  await trashFromTree(page, name);
});
