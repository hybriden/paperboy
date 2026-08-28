<!-- auto-map generated: 2026-08-28 19:40 | git-sha: ff57604 | file-count: 68 (apps/admin/src) | task-context: "mobile usability of admin dashboard + settings" -->
# Architecture Map — Paperboy admin (apps/admin)

## Tech Stack
React 19 + Vite + TypeScript strict. Tailwind v4 with theme tokens (`--c-*` in src/index.css; light + dark via `[data-theme]`). react-router-dom v7, TanStack Query, Radix primitives (menu/dialog/popover/tooltip), @dnd-kit, TipTap. Tests: Playwright e2e only (`e2e/admin.spec.ts` CI suite, `e2e-debug/` local); no unit-test runner in this app (pure lib fns tested via vitest in `src/lib/*.test.ts` run by the API suite? — no: they run under `pnpm --filter @paperboy/api test`? NOT wired; treat e2e as the only gate). Lint: oxlint type-aware (all-error) + scoped eslint rules-of-hooks.

## Module Inventory
- `src/App.tsx` — router: `/dashboard` → DashboardView, `/edit/:id?` → EditView, `/settings` → SettingsView, all under Shell.
- `src/components/Shell.tsx` (226 ln) — app chrome. TopBar (masthead, breadcrumb, search, SiteSwitcher, theme, user), left `Rail` (desktop), `BottomNav` (mobile). **Already mobile-aware**: `useIsMobile()` → hides Rail, shows BottomNav, compacts TopBar.
- `src/components/views/Views.tsx` (422 ln) — `DashboardView` + `SettingsView` (the task's two targets; detail in Task Lens).
- `src/components/views/AdminPanels.tsx` (~2300 ln) — 15 settings panels (ContentTypes, TypeTemplates, Languages, Site, FormSubmissions, Users, DeliveryKeys, Mcp, Ai, StockImages, Webhooks, Audit, Trash, TwoFactor, Password). Row/list based — **zero `<table>` elements**, no fixed widths (one `max-w-[280px] truncate` chip). Hot spot (flagged for split in review retro; don't restructure here).
- `src/components/views/EditView.tsx` — editor screen; already has a phone column (`useIsMobile`).
- `src/components/Editor.tsx` (~2400 ln) — editor internals; `formSection` shared between split pane and phone column. Hot spot.
- `src/lib/useMediaQuery.ts` — `useMediaQuery(query)` + `useIsMobile()` = `(max-width: 639px)` (matches Tailwind `sm` breakpoint). **The one home for the mobile switch.**
- `src/components/ui/*` — Surface, Badge, dialog (has sm: sizing), menu, toast, skeleton, confirm, SidePane (flyout).
- `src/lib/api.ts` — typed API client; TanStack Query keys.

## Data Models
None owned by the admin — all types import from @paperboy/shared (Zod). No serialization risk in this task (pure presentation).

## Dependency Graph
Shell → (SiteSwitcher, CommandPalette, theme, user, useMediaQuery). Views.tsx → AdminPanels (15 panel imports), api, ui/*. EditView → Editor → fields/*. No cycles. Shared config: `src/index.css` tokens consumed everywhere (utility classes `field-*`, `btn-*`, `eyebrow`, `page-title`, `masthead`).

## Test Infrastructure
| type | count | location | runtime |
|---|---|---|---|
| e2e (CI) | ~30 | apps/admin/e2e/admin.spec.ts | vs composed stack in CI; native local stack recipe for dev |
| e2e (debug) | 47 | apps/admin/e2e-debug/ | local only |
| unit (lib) | 7 files | src/lib/*.test.ts | vitest — run via `npx vitest run` in apps/admin? (no `test` script; NOT a gate) |

Contract-test gap relevant here: no viewport-sized e2e — the CI suite runs desktop viewport only.

## Patterns
| category | convention |
|---|---|
| responsive | `useIsMobile()` hook for structural swaps (Shell, EditView); Tailwind `sm:`/`lg:` for flow (Dashboard grids, Login, dialog) |
| styling | token utilities; `Surface` for cards; `eyebrow`/`page-title`/`masthead` editorial headers; NO serif in chrome controls |
| navigation | react-router; Settings tabs are LOCAL state + `location.hash` deep-links (`#site`, `#model:BlogPost`, `#trash`) — hash suffix after `:` consumed inside panels |
| a11y | axe-clean e2e; aria-current on nav; oxlint jsx-a11y all-error |
| touch targets | BottomNav is touch-friendly; 44px floor for mockups per design guidance |

## Hot Spots
| file | why | risk for this task |
|---|---|---|
| AdminPanels.tsx | 2300 ln, 15 panels, flagged for future split | do NOT restructure; panels are already row-based and stack — touch only if a panel genuinely overflows |
| Editor.tsx | 2400 ln | out of scope (already mobile-handled) |
| Views.tsx SettingsView | hash deep-links from dashboard + SiteSwitcher | mobile nav must keep `#tab` and `#tab:suffix` working |

## Task Lens — mobile usability: dashboard + settings
**Broken on ≤639px:**
1. `SettingsView` (Views.tsx:379-421): fixed `w-56` left nav + content in horizontal flex, no mobile branch → content pane ~165px wide on a 390px phone; with `p-8` (32px) padding the panel is unusable. THE core defect.
2. Density: both views use `p-8` page padding + `gap-8`/`mb-8/9` — on phones this wastes ~64px of ~390px.
3. Dashboard rows carry 3-4 trailing chips (badge, mono locale, timestamp, `code` chips, "Open in model →") — locale already `hidden sm:inline`; the rest squeeze the truncating name span but do not overflow the page (flex + truncate). Minor polish only.

**Already fine:** Shell (bottom nav/mobile top bar), Dashboard stat grid (`grid-cols-2 sm:grid-cols-4`), section grids (`lg:grid-cols-2` → stacked), AdminPanels rows (flex + truncate, no tables), dialogs (`sm:` sizing).

**Fix shape (smallest correct):**
- SettingsView mobile = two-level drill: nav list full-width ⇄ active panel full-width with a back control; driven by the existing `useIsMobile()`; hash deep-links (`#trash`, `#model:X`) must land directly on the panel with back available; SiteSwitcher navigates to `/settings#site` — must keep working.
- Responsive padding: `p-4 sm:p-8` (+ matching gap/margin steps) in DashboardView + SettingsView section.
- Keep desktop pixel-identical (all changes behind `sm:`/`isMobile`).
**Verify:** Playwright at 390×844 — settings list→panel→back, deep-link #trash, dashboard scroll/tap targets; axe on both views mobile; desktop e2e suite unchanged.
