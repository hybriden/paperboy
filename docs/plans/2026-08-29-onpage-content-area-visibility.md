# On-page editing: content-area visibility + add-block — Implementation Plan

**Goal:** While the preview bridge is active, every `[data-pb-area]` is visible as a region (dotted outline showing start/end, with the area's name on hover) and carries an "＋ Add block" affordance that opens the admin's block palette for that area (anchored overlay, respecting `allowedBlocks`), appending exactly as the sidebar ContentArea does.

**Protocol rule (hard):** additive only. New iframe→admin message `paperboy:add-block {field, rect}`. Old admin + new bridge: its bundled `parsePreviewMessage` returns null → ignored. New admin + old bridge: no chip, today's behavior. No renames.

**No frontend markup changes:** the bridge injects all visuals/chrome itself (CSS outline via injected stylesheet; ONE fixed-position tag + chip pair in `document.body`, tracked to the hovered area). Never insert DOM *inside* an area — injected children become grid/flex items and break frontend layouts.

**Retrospective lessons applied:** suite claims name exact suites; verify plan premises against real code (all seams read this phase); never run e2e while reviewer subagents run e2e; live verification uses workspace dev servers (apps/web runs the NEW bridge from source; the compose stack still has the old one).

**Baselines (green before work):** @paperboycms/preview 27/27 · admin unit 59/59 · admin tsc clean.

---

### Task 1 — protocol: `paperboy:add-block`
**Files:** `packages/preview/src/protocol.ts`, `packages/preview/src/protocol.test.ts`.
`AddBlockMessage { type: "paperboy:add-block"; field: string | null; rect: Rect }`, added to `FromPreview` + `KNOWN_TYPES`. Test RED first: `parsePreviewMessage({type:"paperboy:add-block", field:"mainArea", rect:{…}})` returns the message (fails on unfixed code with null).
**Accept:** `pnpm --filter @paperboycms/preview test` green incl. new pin.

### Task 2 — bridge: area visuals + add chip
**Files:** `packages/preview/src/bridge.ts`, `packages/preview/src/bridge.test.ts`.
- Injected CSS: `body.pb-editing [data-pb-area]` → `outline:1px dotted ${accent}59; outline-offset:6px` (dotted ≠ the dashed field outline; larger offset so region ≠ element). `:hover` variant slightly stronger. `body.pb-editing [data-pb-area]:empty{min-height:3rem}` so an empty area without a frontend placeholder still has a hover target.
- Area chrome: one `.pb-area-tag` (area field name, top-left) + one `.pb-area-add` button ("＋ Add block", bottom-center), both `position:fixed` in `body`, shown for the area under the pointer (`pointermove` → `closest("[data-pb-area]")`), repositioned via the existing rAF scroll/resize path, hidden on leave; chip click posts `paperboy:add-block` with `checkAreaValue(area)` + the area's rect. Teardown removes both.
**Accept:** RED-first bridge tests — chip appears on area hover with the area name in the tag; chip click posts `paperboy:add-block {field:"mainArea"}`; teardown removes chrome. Suite green.

### Task 3 — admin lib: one home for "what can this area accept"
**Files:** create `apps/admin/src/lib/area-add.ts` + `area-add.test.ts`; modify `apps/admin/src/components/fields/ContentArea.tsx` to consume it.
`allowedBlockTypesFor(field: FieldDef, types: ContentTypeDef[]): ContentTypeDef[]` — exactly ContentArea's current computation (declared `allowedBlocks` order, else `generalBlockTypes`), extracted verbatim. RED first: unit test pinning order + nestedOnly exclusion fails before the file exists.
**Accept:** admin unit suite green (59 + new); tsc clean; ContentArea behavior unchanged (its palette renders from the helper).

### Task 4 — admin: handle add-block, anchored palette overlay
**Files:** `apps/admin/src/components/Editor.tsx`.
- Extend the externalPreview read-only guard to also drop `paperboy:add-block`.
- Handler: field must be a `contentArea` on the PAGE type (mirror `paperboy:drop`'s validation + its toast wording for unknown fields — nested block areas stay out of scope, same as drop). Open `ope` with new variant `{ addArea: string }` anchored at the chip rect.
- Overlay content branch: "Add block" card — allowed inline types as buttons (`allowedBlockTypesFor`), plus shared-block reuse (existing sharedBlocks list filtered to allowed, simple list w/ names). Pick → append with ContentArea's exact instance shapes (`{key,blockType,display:"automatic",inline:{},ref:null}` / `{…,inline:null,ref:documentId}`) via `setField`, close overlay, success toast; autosave + preview reload show it.
- Works in both preview modes (chip is mode-agnostic like drop; overlay renders in both).
**Accept:** admin tsc + unit + `pnpm lint` green; manual live check deferred to E2E phase.

### Task 5 — version + docs
**Files:** `packages/preview/package.json` (0.3.4 → 0.4.0), `packages/preview/README.md` (area visuals + add affordance + message table), root `CLAUDE.md` (protocol list gains `add-block`).
**Accept:** `pnpm -r typecheck` green; README names the new message + degradation story.

**E2E phase (live, not suite):** api+admin+apps/web dev servers (workspace bridge); Playwright MCP drives: on-page mode → area shows dotted outline → hover shows tag+chip → click chip → palette overlay → add inline block → block renders after reload; adversarial: add-block message for a non-field area name → error toast, nothing written; externalPreview (standalone block) → no add handling. Screenshots as evidence.

**Out of scope:** publishing to npm (user, OTP); starter/neoteric bumps (post-publish); insert-between-blocks positioning (append-only v1, same as drop); nested (block-inner) area adds (mirrors drop's page-level rule).
