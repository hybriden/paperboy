# DESIGN-PLAN.md — closing the gap with Sanity Studio

A phased plan to bring paperboy's admin UI to (or past) the level of Sanity.io's
Studio, derived from a side-by-side study of [Sanity UI](https://www.sanity.io/ui)
and the current `apps/admin` codebase.

## Status (implementation)

Delivered on branch `feat/design-system-foundation`:

- **Phase 1 — done.** Semantic tone tokens (positive/caution/critical, light+dark)
  · `Surface` card primitive · `Badge` + `Callout` · `DialogContent` size scale
  (all hardcoded dialog widths removed) · off-token Tailwind reds → `text-danger`.
- **Phase 2 — done, except 2.3.** Inline per-field validation end-to-end
  (`AppError.fields` → API → `ApiError` → inline `FieldError` + aria-invalid +
  scroll-to-first; test-pinned) · `Skeleton`/`SkeletonRows` · `EmptyState`.
  **2.3 (columnar Table) intentionally skipped** — the admin's "tables" are fluid
  row-feeds with conditional columns already unified by `Surface`/`PanelShell`; a
  `<table>` abstraction would fit worse for no gain (YAGNI).
- **Phase 3.1 — done.** A field-by-field diff (`CompareView`/`diffFields`, inline
  word-diff + restore) already existed; added the missing **"Review changes"**
  pre-publish entry point (published → draft) on the publish control.
- **Phase 3.2 — done.** "Used on" references panel: `findReferencingDocuments`
  (reads the maintained `content_reference` index, site-partitioned +
  section-scoped) → `GET …/references` (OpenAPI snapshot updated deliberately) →
  editor "Used on…" dialog. Test-pinned.
- **Phase 3.3 (stega auto-instrumentation) — deliberately deferred.** It's a large
  standalone feature that changes the **published** `@paperboycms/preview`
  contract (consumed by deployed external frontends) with real risk of leaking
  zero-width characters into published delivery output — for what is a refinement,
  not a gap (visual editing already works via `data-pb-*`). It deserves its own
  focused PR + a product decision about maintaining a second instrumentation path,
  not a tail-end addition here.

Every shipped change typechecks, lints, builds, and (for API/contract changes)
passes the DB-backed test gate including the OpenAPI and mcp-parity freeze tests.

---


## Guiding principle

Paperboy's admin is already in good shape: token-driven theming
(`apps/admin/src/index.css`), a thoughtful warm dark mode, Radix primitives under
`components/ui/`, a `cmdk` command palette, on-page visual editing via
`@paperboycms/preview`, and passing a11y. The gap with Sanity is **not** a
ground-up rebuild — it is mostly *systematization* (turning ad-hoc patterns into
reusable primitives) plus a few *editor-UX features*.

**We do NOT adopt `@sanity/ui` wholesale.** It is `styled-components`-based and
would fight our Tailwind + CSS-variable stack and the Code-Quality ladder in
`CLAUDE.md` (rung 3/4: use the platform / installed deps). Instead we port
Sanity's *ideas* — the `Card`+`tone` surface model, semantic tones, a
constraint-based scale, field-level diff — into Tailwind-native primitives that
match how this repo already works.

Effort key: **S** ≈ ½–1 day · **M** ≈ 1–3 days · **L** ≈ 3–6 days · **XL** ≈ 1–2 weeks.

---

## Phase 1 — Design-system foundation

Lowest risk, and it makes every later phase cheaper and more consistent. Do this
first.

### 1.1 Systematize the scale  ·  **S**
**Problem.** Sizing is ad-hoc — arbitrary values like `w-[440px]` for dialogs,
only two radii (`--radius: 9px`, `--radius-lg: 14px`), no small radius for
inputs/badges.
**Work.**
- Keep Tailwind's built-in 4px spacing scale (it is the platform feature — don't
  reinvent Sanity's Fibonacci scale).
- Add a radius step: `--radius-sm` (≈6px) for inputs/badges/chips; expose as
  `rounded-sm` override in `tailwind.config.js` (`borderRadius`).
- Add named dialog/pane width tokens (e.g. `--w-dialog-sm/md/lg`) so we stop
  hardcoding `w-[440px]` at call sites.
**Files.** `apps/admin/src/index.css`, `apps/admin/tailwind.config.js`.
**Done when.** No `w-[NNNpx]` arbitrary values remain in dialogs; radius use is
`sm | DEFAULT | lg` only.

### 1.2 Semantic tone tokens  ·  **M**
**Problem.** We have flat status colors (`--c-published`, `--c-draft`,
`--c-danger`) but no composable tone *system*. Sanity's whole consistency story
rests on tones (`default | primary | positive | caution | critical`) that resolve
correctly per theme.
**Work.**
- Define a canonical tone set: `default`, `primary` (maps to existing accent),
  `positive` (published green), `caution` (draft amber), `critical` (danger red).
- For each tone, define **four** channels as CSS vars in both `:root` and
  `[data-theme="dark"]`: `bg`, `fg`, `border`, and a `subtle` tint (the
  background-fill variant, like today's `--c-accent-50`). Today only accent has a
  tint; add the rest.
- Surface them in `tailwind.config.js` so `bg-positive-subtle text-positive` etc.
  work.
**Files.** `apps/admin/src/index.css`, `apps/admin/tailwind.config.js`.
**Done when.** Every status color is reachable as a tone with all four channels in
both themes; axe contrast still passes (Playwright a11y suite).

### 1.3 `Surface` (Card) primitive with tone inheritance  ·  **M**
**Problem.** Surfaces (cards, panels, panes, popovers) are hand-styled divs.
Sanity's `Card` separates *layout* from *surface* and lets children inherit a
tone automatically, which is what keeps nested surfaces coherent.
**Work.**
- New `components/ui/surface.tsx`: `<Surface tone? elevation? padding? radius?>`.
- Implement tone inheritance the Tailwind-native way: the tone prop sets scoped
  CSS variables on the element (`--tone-bg/-fg/-border/-subtle`); descendant
  components (Badge, Button-ghost, Callout) read those vars by default. This
  reproduces Sanity's "`<Card tone="critical">` colors its children" behavior
  without styled-components.
- `elevation` maps to existing `shadow-panel` / `shadow-pop`.
- Migrate the obvious hand-rolled cards first: dashboard `StatCard`, popover/menu
  bodies, the editor panels. Migrate incrementally — no big-bang.
**Files.** new `components/ui/surface.tsx`; adopt in `views/`, `Editor.tsx`,
`AssetPane.tsx`, dashboard.
**Done when.** A `<Surface tone="critical">` renders coherent child text/borders
with zero per-child color classes; at least the dashboard + editor panels use it.

### 1.4 `Badge` and `Callout` primitives  ·  **S**
**Problem.** Status pills and inline notices are drawn ad-hoc. High reuse, no
primitive.
**Work.**
- `components/ui/badge.tsx` — small pill, `tone` prop, uses 1.2's tokens
  (published/draft status, counts, role labels).
- `components/ui/callout.tsx` — inline banner (icon + text + optional action),
  `tone` prop. Replaces ad-hoc "AI off" hints, warning strips, empty-error notes.
**Files.** new `components/ui/badge.tsx`, `components/ui/callout.tsx`.
**Done when.** Existing status pills and inline hints route through these two.

### 1.5 Dialog size variants  ·  **S**
**Problem.** `components/ui/dialog.tsx` ships one width (~440px).
**Work.** Add a `size` prop (`sm | md | lg | xl`) → the width tokens from 1.1.
Default `md`. Update call sites that currently pass custom widths.
**Files.** `apps/admin/src/components/ui/dialog.tsx`.
**Done when.** Media picker / content-type editor / confirm dialogs use named
sizes, not inline widths.

---

## Phase 2 — Editor UX polish

The most visible day-to-day quality wins.

### 2.1 Inline per-field validation  ·  **L**
**Problem.** Field errors surface as a toast (bottom-right), detached from the
field that failed. Sanity shows errors inline, per field. The API already returns
**self-teaching, field-named** errors (`CLAUDE.md` agent-rule #2 —
`fieldFormatHint` / `formatDataValidation`), so the data is there; we just don't
place it.
**Work.**
- `components/ui/field-error.tsx` — error text styled with `critical` tone, plus a
  `data-invalid` border treatment on `.field-input`.
- Plumb the API error's field path → the matching field in `Editor.tsx` /
  `fields/*`. Show the self-teaching message inline; keep a single summary toast
  ("3 fields need attention") that scrolls to the first error.
- Clear the error on edit; preserve toast for non-field/global errors.
**Files.** `Editor.tsx`, `components/fields/*`, new `field-error.tsx`,
the API-error parsing helper.
**Done when.** Submitting an invalid field shows the message *under that field*,
borders go critical, and the first error is scrolled into view.

### 2.2 Skeleton loading states  ·  **S–M**
**Problem.** Loading = disabled buttons + "Looking…" text; first loads show a bare
spinner. No skeletons.
**Work.**
- `components/ui/skeleton.tsx` — shimmer block respecting `prefers-reduced-motion`
  (reuse the existing `--dur`/`--ease`; pure CSS).
- Apply to: Tree first load, Editor form first load, asset grid, dashboard stat
  cards.
**Files.** new `components/ui/skeleton.tsx`; `Tree.tsx`, `Editor.tsx`,
`AssetPane.tsx`/`MediaLibrary.tsx`, dashboard.
**Done when.** Each major pane shows structure-shaped skeletons on first load
instead of a spinner or empty flash.

### 2.3 Reusable `Table` / `DataList` primitive  ·  **M**
**Problem.** Audit log, activity feed, and user lists are hand-rolled per view
with inconsistent spacing/zebra/sort.
**Work.**
- `components/ui/table.tsx` — semantic `<table>` wrapper: consistent header,
  row hover, density, right-aligned numerics (`.tnum`), optional sort affordance,
  built-in empty + skeleton states.
- Migrate the settings audit log, dashboard activity, and users list.
**Files.** new `components/ui/table.tsx`; settings/dashboard views.
**Done when.** The three existing tabular surfaces share one component; columns
declared via config, not bespoke markup.

### 2.4 `EmptyState` primitive  ·  **S**
**Problem.** Empty states ("No pages yet", "No images without alt text") are
prose-and-button one-offs.
**Work.** `components/ui/empty-state.tsx` — icon + title + body + optional action.
Route existing empties through it.
**Files.** new `components/ui/empty-state.tsx`; Tree, AssetPane, dashboard.
**Done when.** Empty states are visually consistent and centered with a clear CTA.

---

## Phase 3 — Standout features

Highest impact, largest effort. These are the features that make Sanity feel
"better than average," not just polished.

### 3.1 Review Changes — field-level diff before publish  ·  **XL**
**Problem.** Sanity's most-copied feature: a field-by-field diff of what changed
before you publish, plus restorable history. Paperboy has version history but no
diff view — editors publish blind.
**Work.**
- **API.** Endpoint to fetch two revisions of a document (draft vs published, or
  any two history entries) for diffing. Reuse existing version storage; respect
  the site partition and the no-leak chokepoint (`CLAUDE.md` multisite + delivery
  rules — diffing is a management read, gate on `AccessContext.siteId`).
- **Diff engine.** Per *field type* (the content model knows types via
  `fieldTypes`): text → inline word diff; markdown/richtext → block-level
  add/remove/change; image → before/after thumbnail; reference → resolved-name
  change; number/boolean/datetime → value swap. Put pure diff logic in
  `packages/shared` so it is unit-testable without a DB (matches the
  `shared-*.test.ts` convention) and reusable by MCP later.
- **UI.** A "Review changes" pane/tab in the editor (right split), two-column
  before/after with changes highlighted using the `critical`/`positive` tones from
  Phase 1. Entry point on the publish button.
- **History.** Let editors open any prior revision, diff it against current, and
  restore.
**Files.** new API route (`apps/api`), diff module in `packages/shared` + tests in
`apps/api/test/shared-*.test.ts`, new editor pane in `apps/admin`.
**Done when.** Clicking "Review changes" shows an accurate per-field diff between
draft and published; restoring a revision works; diff logic is covered by
`shared` unit tests.
**Risk.** Largest item. Build the `shared` diff module + tests first, wire UI
after. Richtext diffing is the hard part — start with block add/remove/move and
treat intra-block text changes as block-level "changed" before attempting inline
prose diff.

### 3.2 "Used on" / references panel  ·  **M**
**Problem.** Sanity shows, in real time, every document referencing the current
one. Paperboy resolves references forward but offers no reverse view, so editors
delete/change shared blocks without seeing the blast radius.
**Work.**
- **API.** Reverse-reference query: given a documentId, list content items whose
  `reference`/`contentArea` fields point at it. Must honor the site partition
  (deny-by-default scan, same as `getTree`/`searchContent` in `packages/db`).
- **UI.** An editor panel/tab listing referencing pages with type + name, each a
  link that navigates the tree/editor to it. Show it especially for `block`/
  `global` kinds.
**Files.** query in `packages/db`, route in `apps/api`, panel in `apps/admin`
editor.
**Done when.** Editing a shared block shows which pages use it; clicking navigates
there; cross-site refs never appear (partition holds).
**Synergy.** Pairs naturally with the tenant/shared-content delete safeguards
already in the codebase.

### 3.3 (Optional) Reduce manual preview instrumentation  ·  **L**
**Problem.** Sanity's visual editing auto-instruments via stega-encoded
zero-width characters, so click-to-edit needs no manual markup. Paperboy's
on-page editing already works but relies on the explicit `data-pb-*` DOM contract
in `@paperboycms/preview`.
**Work.** Evaluate adding optional stega-style auto-tagging in the delivery
output + preview package so frontends get click-to-edit with less manual
`data-pb-*` wiring — **additive only**: the `@paperboycms/preview` protocol is
consumed by deployed external frontends, so per `CLAUDE.md` "additions yes,
breaking renames no," version both sides deliberately.
**Files.** `packages/preview`, `apps/api` delivery, `apps/web` reference frontend.
**Done when.** A frontend can opt into auto-instrumented click-to-edit without
hand-authoring every `data-pb-*` attribute, with the existing contract intact.
**Note.** Lowest priority — current visual editing is already a strength; this is
a refinement, not a gap.

---

## Sequencing & dependencies

```
Phase 1 (foundation) ──► Phase 2 (polish) ──► Phase 3 (features)
   1.1 scale
   1.2 tones ──────────► 1.3 Surface ─► 1.4 Badge/Callout
                                         └► 2.1 inline validation (uses critical tone)
                                         └► 3.1 diff UI (uses critical/positive tones)
   1.5 dialog sizes
```
- **1.2 tones gates 1.3/1.4/2.1/3.1** — do tones early; everything visual leans on
  them.
- Phases 2 and 3 are largely independent of each other once Phase 1 lands; 3.1 and
  3.2 can run in parallel (different layers).
- Every change keeps the contract-freeze tests green (`delivery-contract`,
  `openapi-snapshot`, `mcp-parity`); any API addition for 3.1/3.2 updates the
  OpenAPI snapshot deliberately, never blind `--update`.

## Explicitly out of scope (for now)
- Adopting `@sanity/ui` or `styled-components` — conflicts with the Tailwind stack.
- Real-time multi-user presence / `AvatarStack` — a collaboration feature, not a
  design-system gap; revisit separately.
- A Storybook / component gallery — nice, but YAGNI until the primitive set above
  exists and stabilizes.

## Suggested first PR
Phase 1.1 + 1.2 + 1.3 together: the scale, the tone tokens, and the `Surface`
primitive with the dashboard + editor panels migrated. Self-contained, low-risk,
no API changes, and it unblocks everything else.
