# Admin dashboard + settings usable from mobile — Implementation Plan

**Goal:** On phone widths (≤639px) the dashboard reads comfortably and Settings is fully operable. Desktop stays pixel-identical.
**Architecture:** Pure presentation change in `apps/admin` — no API, no shared packages, no data models.
**Architecture Map:** docs/architecture-map.md (task lens: SettingsView fixed `w-56` sidebar is the core defect; dashboard needs padding steps; AdminPanels rows already stack; Shell already mobile-aware).
**Modules Involved:** `src/components/views/Views.tsx` (both views), `e2e/admin.spec.ts`.
**Hot Spots Affected:** none structurally — AdminPanels.tsx (hot spot) is NOT touched; Views.tsx SettingsView carries the hash deep-link contract that must survive.
**Tech Stack:** React 19, Tailwind v4 tokens, `useIsMobile()` (max-width 639px, = Tailwind `sm`).
**Test Framework:** Playwright e2e (the admin's only gate) + typecheck + oxlint.
**Coverage Target:** n/a (no unit runner in admin); every new behavior gets an e2e assertion.

**Retrospective lessons applied** (from today's auto-review retro): every interactive element added (back control, drill rows) gets a behavioral e2e assertion planned up front; ambiguous words avoided — "drill" means list ⇄ panel two-level navigation on mobile only.

**Existing contracts that must hold:**
- Hash deep-links are read AT MOUNT (`window.location.hash`): `/settings#trash` and `/settings#webhooks` (dashboard `navigate()`), `/settings#model:<name>` (dashboard), `/settings#site` (SiteSwitcher via full `window.location.href` navigation). All arrive as fresh mounts — the mobile drill must open the panel directly when the hash names a visible tab.
- The `:suffix` after the tab key is consumed inside panels — untouched.
- Desktop DOM/classes unchanged: `w-56` nav + side-by-side layout, no back control rendered.

---

### Task 1: Views.tsx — Settings mobile drill + responsive density
**Files:** Modify `apps/admin/src/components/views/Views.tsx` (SettingsView lines ~346-421; DashboardView container line ~171).
**Acceptance Criteria:**
1. At 390×844, `/settings` renders the section nav as a full-width list (no side-by-side panel); each row is a ≥40px-tall touch target with a right chevron.
2. Tapping a section replaces the list with ONLY that section's panel, headed by a back control labeled "Settings" (button, accessible name includes "Settings").
3. The back control returns to the list (panel unmounts, list visible).
4. At 390×844, `/settings#trash` (fresh navigation) shows the Trash panel directly with the back control present.
5. At ≥640px, the rendered markup is unchanged: `w-56` nav visible beside the panel, no back control in the DOM, tab switching works as today.
6. Dashboard and settings-section page padding: 16px (`p-4`) below `sm`, 32px (`sm:p-8`) at `sm+`. No horizontal page overflow at 390px on `/dashboard` or `/settings`.
7. `pnpm --filter @paperboy/admin typecheck` and `pnpm lint` pass.

**Design (minimal):**
- `const isMobile = useIsMobile();` in SettingsView (import exists in the file's sibling views; add import from `../../lib/useMediaQuery.js`).
- One extra state: `const [mobilePanel, setMobilePanel] = useState(() => tabs.some((t) => t.key === hashTab));` — true when a hash deep-link named a tab (criterion 4). Selecting a tab: `setActive(key); setMobilePanel(true);`. Back: `setMobilePanel(false)`.
- Render: desktop branch exactly as today. Mobile branch: `mobilePanel === false` → the nav list full-width (rows get `py-2.5` + `Icon.Chevron` right, `aria-current` kept); `true` → the section pane full-width with a back button (`Icon.Chevron` rotated 180 + "Settings") above the existing header, `p-4` padding.
- DashboardView: `p-8` → `p-4 sm:p-8` on the container (line ~171); settings section pane `p-8` → `p-4 sm:p-8`. Nothing else moves.

**Steps:** 1. Write Task 2's e2e first (red) · 2. Run the three new tests against the local stack → FAIL (settings side-by-side at 390px; no back control) · 3. Implement the design above · 4. Re-run → PASS · 5. Typecheck + lint · 6. Commit "feat(admin): settings drill navigation and dashboard density on phones".

### Task 2: e2e — mobile viewport coverage
**Files:** Modify `apps/admin/e2e/admin.spec.ts` (append a `test.describe` block; reuse `login`, `blockToggle` conventions).
**Acceptance Criteria:** the following pass on the native local stack AND the existing desktop settings/dashboard tests still pass:
```ts
test.describe("mobile (390×844)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("settings drills list → panel → back, and deep-links open the panel", async ({ page }) => {
    await login(page);
    await page.goto("/settings");
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    await expect(nav).toBeVisible();
    // List first, no panel beside it: the active-section heading is not rendered yet.
    await expect(page.getByRole("heading", { name: "Content types", exact: true })).toHaveCount(0);
    await nav.getByRole("button", { name: "Trash" }).click();
    await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
    const back = page.getByRole("button", { name: /Settings/ }).first();
    await expect(back).toBeVisible();
    await back.click();
    await expect(nav).toBeVisible();
    // Deep-link (fresh mount) lands on the panel directly.
    await page.goto("/settings#trash");
    await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
  });

  test("dashboard has no horizontal overflow and stats stack", async ({ page }) => {
    await login(page);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Newsroom dashboard" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
  });
});
```
(Exact selectors to be adjusted to the real accessible names while implementing — the BEHAVIORS asserted are the criteria: list-first, tap-to-panel, back, deep-link-to-panel, no horizontal overflow.)
**Steps:** written FIRST (Task 1 step 1); red before the implementation, green after.

**Test strategy note:** `login()` at 390px must work — Login.tsx already carries `sm:` classes; if login breaks at 390px that is a real finding, fix minimally (padding only) rather than widening the viewport.

**Out of scope (documented):** EditView/Editor (already mobile-handled), AdminPanels internal layouts (row-based, stack fine; the flagged file split stays deferred), Shell (already mobile-aware), hash-change-while-mounted reactivity (not today's behavior on desktop either).
