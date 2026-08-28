# Admin forms builder — Implementation Plan

**Goal:** Building a form in the admin should feel like a forms builder, not like generic block plumbing — while the form-as-content model (storage, ordering, versioning, RBAC, preview, MCP, the submit chokepoint) stays byte-identical.

## Design rationale (the grounding the task demands)

**Logic.** FORMS_PLAN.md §9 excluded "a bespoke drag-and-drop form designer" with the reasoning "content areas already order fields". That reasoning still holds and this plan obeys it: nothing here adds a parallel model. What §9 did NOT decide is how the existing area RENDERS when its blocks are questions — that is presentation, and presentation is where the clunk lives. The builder is therefore a specialized rendering of the same `BlockInstance[]`, switched on `isFormFieldType` (the same predicate delivery and coercion already use), driven by the type's own `FieldDef` list so copy (displayName/helpText) keeps its single source in `BUILTIN_TYPE_TEMPLATES`.

**UX (each choice names its principle):**
- *Progressive disclosure* — a question is its Label + Required 95% of the time. Essentials render first (Label, Required, type extras like Options); the technical half (Field key, min/max/pattern, error copy) folds behind an "Answer rules & key" disclosure. Today all 8-9 editors sit at equal weight.
- *Recognition over recall* — a visitor-eye preview of the question (label, required mark, help text, the actual control shape with parsed options) renders live at the top of the open question. Editors see what they are making, not a form about a form. (Optimizely/Umbraco both lead their field editors with a rendered preview; it is the single feature that makes a builder read as a builder.)
- *Match the system to the real world* — the area's add affordance says "Add question" when every allowed block is a form part; the palette already shows friendly names + icons from the templates.
- *Error prevention over error messages* — the Options editor parses `value|Label` lines as you type and shows the parsed options as chips, with inline warnings for duplicate/empty values — instead of a silent markdown string that "fails silently to empty" (a live incident already in the project notes).
- *Aesthetic-minimalist* — the current Options editor is a full MarkdownEditor with a B/I/H2 toolbar for plain option lines; it becomes a plain per-line textarea.
- *Consistency* — grouping the Form block's 11 settings uses the editor's NATIVE group→tab machinery (zero new UI): Content / After submitting / Protection & privacy. WCAG hooks already in the templates (labels never placeholders, editor-authored error copy per 3.3.3) are surfaced, not duplicated.

**UI.** Tokens only, existing primitives (field-input/field-label, ui/switch, the block envelope from this week). The preview mock is non-interactive (`disabled` controls), tonally distinct (canvas surface inside the envelope), and never pretends to be the real frontend — the side-by-side preview remains the truth.

**Best practices.** No storage change ⇒ `formSpecFrom`/`submissionSchemaFor`/coercion/MCP untouched and their pinned tests stay authoritative. The one contract file that changes meaning (template field groups) is updated in the same change as its pinned test, plus a forward-only migration for installed built-ins (precedent: migration 0024 flagged nestedOnly on existing rows).

**Architecture Map:** docs/architecture-map.md (forms-builder lens).
**Modules:** packages/shared (type-templates), packages/db (migration 0025), apps/admin (ContentArea + new FormQuestionEditor), apps/api/test (template invariants), apps/admin/e2e.
**Hot spots:** AdminPanels/Editor NOT restructured; ContentArea integration is a render-path switch, additive.
**Out of scope (unchanged §9):** file uploads, conditional logic, multi-step, payments, autoresponders, spam scoring, A/B — and any storage/protocol change.

---

### Task A: Form settings groups (shared template + migration + pinned test)
**Files:** Modify `packages/shared/src/type-templates.ts` (Form block fields get `group`); Create `packages/db/migrations/0025_form_field_groups.sql`; Modify `apps/api/test/shared-builtin-templates.test.ts`.
**Groups:** Content = title, intro, fields, submitLabel · "After submitting" = confirmation, confirmationText, redirectTo · "Protection & privacy" = spamProtection, notifyWebhooks, retentionDays, captureMetadata, notifyEmail.
**Migration:** UPDATE the installed built-in `Form` content_type row's `fields` jsonb, setting `group` per the mapping above ONLY where the field name matches and no group is set (idempotent; a customized group wins). Forward-only.
**Acceptance:** template test pins the exact group mapping (fails if a field is added ungrouped); API suite green; seeded fresh DB shows three tabs on a Form document.

### Task B: e2e first — the builder's behaviors (RED before Task C)
**Files:** Modify `apps/admin/e2e/admin.spec.ts` — new `test.describe("forms builder")`.
Scenarios (create a throwaway shared Form via the API like the Publish-state test, open `/edit/:id`):
1. The fields area's add affordance reads "Add question"; the palette lists "Text field" etc.
2. Add "Text field": the open question shows the visitor-eye preview; typing Label "Your name" → preview label updates; blur → key chip shows `yourName`.
3. Required toggle in essentials; "Answer rules & key" disclosure initially CLOSED, opening it reveals Field key / lengths / pattern / error message.
4. Add "Dropdown": the Options editor is a plain textarea (no markdown toolbar buttons); typing `support|I need help` + `sales` yields parsed chips "I need help" and "sales"; a duplicate value line shows a warning.
5. Form settings tabs exist: "After submitting" and "Protection & privacy".
**Expected RED:** generic editors, markdown toolbar present, no disclosure, no preview, single tab.

### Task C: FormQuestionEditor + ContentArea integration (GREEN)
**Files:** Create `apps/admin/src/components/fields/FormQuestionEditor.tsx`; Modify `apps/admin/src/components/fields/ContentArea.tsx` (open-block path: `isFormFieldType` → FormQuestionEditor; add-row copy "Add question" + empty copy when all allowed blocks are form parts).
**Component contract:** props `{ type: ContentTypeDef; block: BlockInstance; disabled; onUpdate(patch) }`. Field partition is DATA-driven: ESSENTIAL names = label, required, helpText, placeholder, choices, rows, min, max, heading, body; RULES = name, minLength, maxLength, pattern, errorMessage. Each leaf field renders via the existing generic editors EXCEPT `choices` (plain textarea + parsed chips + duplicate/empty warnings, writing the identical value|Label lines). Label keeps the `withDerivedKey` commit behavior (move the call, don't fork it). Visitor-eye preview switches on the shared form-field kind map (single source) and renders disabled controls with label/required/help/options.
**Acceptance:** Task B green; desktop + mobile e2e suites green; typecheck/lint green; generic (non-form) blocks render exactly as before (canary: end-cap test).

### Task D: verification breadth
Full admin unit suite; API suite files: shared-builtin-templates, forms-submit, mcp-parity (tool surface untouched — must stay green), update-ergonomics; admin e2e: forms describe + mobile describe + settings/canaries. Screenshots (light) of the builder for the report.

**Sequencing:** B (red) → A (independent, its own gates) → C (green) → D. A and C share no files; B and C share the spec file with C only making it pass (no edits to B's assertions except selector reality-fixes, logged).
