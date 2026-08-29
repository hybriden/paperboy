# Standalone block preview — Implementation Plan

**Goal:** Any shared block previews without a host page: the frontend serves `/{locale}/preview/block/{documentId}` (preview-authenticated), rendering the block with its real inline component on a bare shell; the admin defaults a block's Side by side to that route, demoting the borrowed-page picker to secondary context. Forms gain preview-while-building.

**No API change**: `GET /delivery/content/:documentId` (already public contract, `client.getById`) serves the block, `?pbt` pass-through already authenticates preview. **No breaking change**: frontends without the route behave as today (the picker still offers host pages; the bridge hint explains an empty frame).

**Retrospective lessons applied:** suite claims name the exact suites run; no migrations (numbering n/a); apps/web conventions are cloned from its own route files (its AGENTS.md warns this Next version diverges from training data).

### Task A — apps/web (the contract-pinning reference)
**Files:** Modify `app/lib/delivery.ts` (+`fetchById`); Create `app/lib/standalone-block.ts` (pure `standaloneAreaBlock(content): AreaBlock` — blockType/display/shared/content{documentId,type,kind,name,data,fieldTypes,form} mapping); Create `app/[locale]/preview/block/[documentId]/page.tsx` (force-dynamic; REQUIRES preview auth — draft-mode cookie, `?pbt`, or `?pb` — else `notFound()`: the route is editor chrome, not a public surface, and must not open draft reads by id enumeration); Create `app/components/StandaloneBlock.test.tsx` (mapping unit test + a Block render of a synthesized Form block asserting the real form renders).
**Route body:** marker line ("Standalone preview — this block renders here without a page"), `<Block b={standaloneAreaBlock(content)} index={0} locale preview/>`, `<PreviewBridge/>` — cloned conventions from `[locale]/[[...path]]/page.tsx` (async params, isPreview helper reuse — export it or duplicate minimally).
**Acceptance:** unit tests green; route 404s without preview credentials; nesting beats the `[[...path]]` catch-all (asserted by the admin e2e in Task B against the compose stack in CI; locally by unit-level render).

### Task B — admin default-to-standalone
**Files:** Modify `apps/admin/src/components/Editor.tsx`, `apps/admin/e2e/admin.spec.ts`.
- Blocks: Side by side ENABLED always (kind === "block"); preview target default = `/preview/block/{documentId}`; the toolbar picker becomes "Standalone" + one option per using page (borrowed mode unchanged, incl. its read-only bridge suppression; standalone does NOT suppress — the framed doc IS the edited doc, so field-click focus works through existing machinery). On-page stays disabled for blocks (v1; overlay anchoring on the standalone shell is a designed follow-up).
- e2e: UPDATE the "never hides" pin deliberately — an unused form now has Side by side ENABLED; clicking it frames `/preview/block/{id}` (assert iframe src) with the "Standalone" picker shown. The borrowed-page test keeps passing by selecting the host page in the picker (update it to pick explicitly). RED first: the new src assertion fails before implementation.
**Acceptance:** forms e2e describe green (all, updated); mobile + canaries green; typecheck/lint green.

### Task C — contract docs
CLAUDE.md frontend-starter section: add the standalone route to the documented preview contract (alongside `{previewBaseUrl}/{locale}{urlPath}` framing), noting it is optional-but-expected and what degrades without it.

**Out of scope:** the Astro starter's route (separate repo, after this run); on-page editing on the standalone shell; globals (props-only stays).
