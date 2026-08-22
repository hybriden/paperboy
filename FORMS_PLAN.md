# Customizable forms plan (BUILT — phases 0–2 shipped)

> Status: **implemented 2026-08-22.** All seven decisions resolved as recommended
> (D1 form-as-content, D2 Paperboy stores submissions, D3 existing public key,
> D4 webhooks not email, D5 localized fields area, D6 no file uploads, D7 no
> conditional logic). Phases 0, 1 and 2 are done; phase 3 remains out of scope.
> The implementation notes live in CLAUDE.md ("Forms and submissions").
>
> Originally written as — **Goal**: editors build a form in the
> CMS (fields, labels, validation, consent copy) without a deploy, frontends
> render it from the Delivery API, and submissions land in **this instance's own
> Postgres** with retention built in.
>
> Written: 2026-08-22. Research: Optimizely Forms, Umbraco Forms, Payload,
> Strapi, Directus, Keystone, Ghost, Contentful, Sanity, Storyblok, Kontent.ai,
> Prismic + the cross-cutting spam/GDPR/a11y/deliverability literature (§11).

---

## 1. Verdict

**Build it, and own the submissions.** Two findings decide the shape:

1. **Every headless CMS surveyed models form *definitions* as content and refuses
   to store *submissions*.** Their three stated reasons are structural: a headless
   CMS serves many channels; a statically-generated site has no server to receive
   a POST; and their write tokens can't ship to a browser, so a server hop is
   needed anyway. **None of the three applies to Paperboy** — it is self-hosted,
   ships an always-on Fastify API and its own Postgres, and already authenticates
   public traffic with per-site delivery keys.
2. **Nobody does retention well.** Not one open-source headless CMS captures
   submission metadata or implements GDPR retention out of the box; the dedicated
   form vendors mostly leave it to the customer; Umbraco ships a per-form
   retention policy that is silently inert unless a separate scheduled task is
   enabled in `appsettings.json`. Paperboy already runs a scheduler
   (`runScheduledPublish`, `apps/api/src/app.ts:195-206`), so doing this properly
   is cheap.

That combination is the product position: **the form is content, the submissions
stay in your database, and they expire on a schedule you set.** For a
self-hosted CMS that is a real differentiator over Netlify Forms / Formspree /
HubSpot, where EU visitor PII leaves the customer's infrastructure entirely.

**Cost of admission:** this opens Paperboy's first public *write* endpoint. That
is the single biggest security expansion in the project's history and the plan
treats it as such (§7, §10).

---

## 2. Why now

`www.neoteric.no`'s contact form is hand-rolled in Astro
(`src/pages/api/contact.ts`): the fields `name`/`email`/`message` are hardcoded,
Turnstile is verified inline, and Resend sends the mail. Adding a field means a
code change and a deploy — exactly the work a CMS is supposed to absorb. It is
also the ideal acceptance test: when this plan is done, that endpoint and its
hardcoded markup are deleted and the form is authored in Paperboy.

---

## 3. Competitive landscape

### 3.1 Where the form DEFINITION lives

| Product | Definition model | Versioned / publishable | Notes |
|---|---|---|---|
| **Optimizely Forms** | **Content.** `FormContainerBlock` is a block; each field is a child block in its content area | Yes — same draft/publish/versioning/access as any block | Closest prior art to what we should do. Localization gaps: dropdown *options* aren't per-language, and the send-email actor isn't `LanguageSpecific` |
| **Umbraco Forms** | **Separate entity.** Own backoffice section, own tables; JSON-or-DB storage (switch is irreversible) | **No** draft/publish, no content versioning | Split-brain permissions (own "Manage Forms" model) produced real permission bugs (#1058, #1102); dashboard degrades past ~200 forms (#1119) |
| **Payload** | **Content-ish.** `forms` collection with a `fields` Blocks array | Payload's normal versioning | The most complete OSS forms product; admin UI is generated, no bespoke builder |
| **Strapi** | DIY: `Form` collection type + Dynamic Zone of field components | Normal Strapi | 6+ competing plugins, none canonical |
| **Directus** | DIY: `forms` + `forms_components` via Many-to-Any | Normal Directus | No forms concept by design |
| **Storyblok** | **Content.** `Form` bloc nests field bloks, which nest `Validators` bloks carrying editor-authored error copy | Normal Storyblok | Five first-party tutorials — the deepest forms-as-content pattern documented anywhere |
| **Contentful / Sanity / Kontent.ai / Prismic** | Content (patterns, not products) | Normal | Prismic staff: "we don't support user submitted data"; slices lack clean field repeatability |

**Take:** the content model wins. Optimizely and Storyblok both prove an ordered
list of field blocks is a natural, editor-friendly form definition, and Umbraco's
separate-entity approach is the cautionary tale — it re-implemented permissions
and versioning badly rather than inheriting them.

### 3.2 Where the SUBMISSIONS live

| Product | Submission store | Server-side validation against the form schema | Export | Retention |
|---|---|---|---|---|
| **Optimizely Forms** | Dynamic Data Store (generic shared store; pluggable `IFormSubmissionStorage`) | Yes | CSV/XLSX/JSON/XML in UI | **Yes**, per-form ILM policies; docs warn it is not long-term storage |
| **Umbraco Forms** | Dedicated SQL (`UFRecords` + typed value tables) | Yes | Excel/CSV | Per-form, **but inert unless a scheduled task is separately enabled** |
| **Payload** | `form-submissions` collection: `submissionData` array of `{field, value}`; create public, read authenticated, update disabled | **No — documented gap**, [issue #50](https://github.com/payloadcms/plugin-form-builder/issues/50) closed "not planned"; the frontend is trusted | Needs a second official plugin | No |
| **Strapi** | DIY `Submission` type with a JSON blob | Tutorial controller re-derives rules from the live schema | Plugin-only (several competing) | No |
| **Directus** | DIY collection | Collection-level validation only | **Native in every collection** (CSV/JSON/XML/YAML) | No |
| **Headless SaaS (all 5)** | **Not in the CMS** — Netlify Forms / Formspree / HubSpot / custom serverless | n/a | n/a | n/a |

**Take:**
- **Copy Payload's shape, close its hole.** Its `forms` + `form-submissions`
  split, `confirmationType: message|redirect`, and `{{field}}` / `{{*}}` /
  `{{*:table}}` email interpolation are good design. Its refusal to validate
  submissions server-side is precisely what
  [CLAUDE.md rule 1 (never garbage-in-success-out)](CLAUDE.md) forbids.
- **Match Directus on export** — native, not a second plugin.
- **Beat everyone on retention** — and specifically avoid Umbraco's footgun by
  running the sweeper in-process by default, not behind separate config.

### 3.3 Spam defence, as shipped

| Product | Honeypot | CAPTCHA | Rate limiting |
|---|---|---|---|
| Optimizely Forms | **No** (community builds it; one author rejected CAPTCHA as "annoying real users and typically not WCAG compliant") | Image CAPTCHA + reCAPTCHA | IP/cookie duplicate-submission throttle only |
| Umbraco Forms | **No** (third-party package) | reCAPTCHA v2/v3/Enterprise | **None** on the headless API |
| Payload | No | No | No |
| Netlify Forms | Opt-in | reCAPTCHA | Quota-based |
| Formspree / Basin | Yes | reCAPTCHA + Akismet | Plan-based |

**Take:** honeypot + a minimum fill-time heuristic is free, invisible, costs no
accessibility, and blocks the overwhelming majority of naive bots — and *neither*
enterprise .NET product ships it. Turnstile (managed mode) is the escalation, not
the default: both major CAPTCHA vendors are documented as failing WCAG 1.1.1 in
practice for screen-reader and motor-impaired users.

### 3.4 The headless rendering lesson

Optimizely's first headless Forms API **embedded pre-rendered HTML inside the
JSON response**, which made frontend styling a fight and is one of its most-cited
complaints; a raw-configuration API plus a JS SDK only reached beta in 2024.
Umbraco's Forms API (opt-in) returns the definition — fields, validation
patterns, error messages, conditional rules — and takes submissions with `202`
or `422` + field-level errors.

**Take:** deliver the **schema, never markup**. Paperboy's delivery contract
already exposes `fieldTypes` per item so frontends switch on declared type rather
than sniffing values — forms extend that principle instead of inventing a new
one. Rendering help belongs in `@paperboycms/client`, where a frontend can take
it or leave it.

### 3.5 The trap Storyblok documents

In Storyblok's own tutorial, editors declare which validators apply and author
the error copy — but `react-hook-form` re-implements the rules client-side. The
CMS schema is *a declaration of intent, not an enforced contract*. Paperboy must
not ship that: the same declaration that renders the form must be the thing the
server enforces on submit (§6.4).

---

## 4. Current architecture (factual map — verified 2026-08-22)

**Reusable as-is**
- **Content types are data** (`content_type.definition`), with `FieldDef` already
  carrying `required`, `validation` (minLength/maxLength/min/max/regex),
  `options`, `multiple`, `localized`, `delivery: public|private`, `group`,
  `helpText` — most of a form field's vocabulary already exists
  (`packages/shared/src/content-types.ts:118-183`).
- **Content areas** hold ordered `BlockInstance`s, inline or shared, drag-
  reorderable, nestable to `MAX_AREA_DEPTH = 4`
  (`apps/admin/src/components/fields/ContentArea.tsx:48`).
- **`dataSchemaFor(type, strict)`** compiles a Zod schema from field defs
  (`content-types.ts:351`) — the exact pattern submission validation needs.
- **Type templates**: `BUILTIN_TYPE_TEMPLATES` ships read-only recipes with
  reserved names (`packages/shared/src/type-templates.ts`) — the delivery vehicle
  for a "Contact form" out of the box.
- **Webhooks are production-grade**: HMAC-SHA256 signed, SSRF egress guard with
  DNS re-check at dispatch, delivery log, 5s timeout, fire-and-forget
  (`packages/db/src/webhooks.ts`). Events today: `content.published`,
  `content.unpublished`.
- **Scheduler**: `runScheduledPublish` on boot + a 60s `setInterval`, unref'd,
  cleared on close, disabled under test (`apps/api/src/app.ts:195-206`).
- **Per-site delivery keys**: `verifyDeliveryKey` → `{ type: "public" | "preview", siteId }`
  (`packages/db/src/auth-store.ts:545-557`); `site` carries `canonical_base_url`
  and `preview_base_url` — i.e. the allowed frontend origins are already known.
- **Audit log** (`audit`, `auth-store.ts:562`), **RBAC** (10 permissions;
  Admin/Editor/Author/Viewer + per-site section scopes), **rate limiting**
  (`@fastify/rate-limit`, global per-IP, `RATE_LIMIT_MAX`).

**Constraints**
- **No email transport exists anywhere.** 2FA is TOTP-based — email is only an
  identifier. There is no nodemailer/Resend/SES dependency and no outbound
  `fetch` in the API. Notifications must therefore start as webhooks (§6.6).
- **Delivery is GET-only** — 12 GET routes, zero writes, and "a single read
  chokepoint" is a documented law. Accepting submissions requires a *deliberate,
  separate* write surface (§6.3), plus an amendment to CLAUDE.md.
- **Inline block payloads are not strictly validated on write**
  (`inline: z.record(z.string(), z.unknown())`, `content-types.ts:296`) — a known
  open gap. If field definitions are blocks, a malformed definition reaches a
  public form. **This must close first** (Phase 0).
- **Content types are shared across sites** (multisite decision D2); form
  *instances* are per-site content. That is the correct split.

---

## 5. OPEN DECISIONS

Recommended defaults in **bold**. These fork the architecture.

### D1 — How is a form defined?
- **(rec) As content**: a `Form` block type whose `fields` content area holds
  field blocks (`FormTextField`, `FormEmailField`, …). Inherits versioning,
  draft/publish, scheduling, i18n, RBAC, preview + on-page editing, MCP, the AI
  copy desk, and drag-drop ordering. Zero new admin UI. Shipped as built-in type
  templates. This is Optimizely's model and Storyblok's documented pattern.
- A first-class `form` + `form_field` table pair (Umbraco/Payload). Full control,
  but re-implements versioning, i18n, permissions and admin UI — the ladder's
  rule 1 says don't.
- One JSON blob field on a content type. No drag-drop, poor editor UX.

### D2 — Does Paperboy store submissions?
- **(rec) Yes**, in a first-class `form_submission` table, accepted by a narrow
  public endpoint. Data stays in the customer's Postgres; editors see submissions
  in the admin; retention is enforced by the CMS.
- Definition-only ("bring your own endpoint", the headless-SaaS answer). Zero new
  attack surface — and zero improvement over today's hand-rolled endpoint.
- Both: own it, plus optional forwarding. Forwarding is just the webhook (§6.6),
  so this collapses into the recommendation.

### D3 — What authenticates a submission?
- **(rec) The site's existing public delivery key.** It is already embedded in
  the frontend; a dedicated "submit key" adds configuration without adding
  protection, because any credential a public form can use is a credential an
  abuser can read. Real protection is rate limiting + spam heuristics + Turnstile.
- A third `delivery_key.type = "submit"`, revocable independently of reads. More
  surgical revocation; more moving parts.

### D4 — Notification transport
- **(rec) `form.submitted` on the existing webhook system.** No new dependency,
  inherits HMAC signing + SSRF guard + delivery log. The box already runs n8n,
  which can send mail, post to Slack, or push to a CRM.
- Add an email provider seam now (mirroring the AI provider seam: Resend or
  SMTP). Better out-of-box UX, but drags in deliverability ownership
  (SPF/DKIM/DMARC alignment, `From` must be our domain with the submitter in
  `Reply-To`, CRLF stripping on every header-bound value). Defer to Phase 3.

### D5 — Localization of the form structure
Paperboy's i18n is per-field `localized`. If the `fields` area is localized, each
locale gets its own copy of the whole area: labels are translatable, but the
*structure* can drift between locales (a field added in `en` won't exist in `nb`).
If it isn't localized, structure is shared but labels can't be translated.
- **(rec) Localized area** (translatable labels; drift accepted and surfaced),
  since a form with untranslatable labels is useless on a bilingual site. Mitigate
  with the existing translate flow and a "structure differs from source locale"
  warning in the admin. Optimizely has the strictly worse version of this problem
  (options and the email actor are not per-language at all).
- Non-localized area + a per-locale label map inside each field block. Keeps
  structure identical; a new concept to build and explain.

### D6 — File uploads
- **(rec) Out of scope for now.** OWASP's control set is long (allow-list by
  magic bytes not `Content-Type`, random rename, store outside webroot, size
  caps, AV scan, download proxy with `Content-Disposition: attachment`), and
  Umbraco shipped CVE-2021-37334 on exactly this. Public writes into the asset
  library also mix visitor uploads with editorial media.
- Phase 3+ with a quarantine bucket, signed single-purpose upload URLs (so bytes
  never ride in the submission body), AV scan before promotion, and submissions
  storing only an asset reference.

### D7 — Conditional logic / multi-step
- **(rec) Out of scope for now.** Gravity-Forms-grade conditional logic is a
  product in itself; Optimizely's multi-step needs sticky sessions and has
  documented step-rendering bugs; Umbraco's headless multi-page state is entirely
  client-managed.
- If added later: declare rules in the definition and evaluate them on **both**
  sides — client for UX, server as the authority — or we ship Storyblok's
  "intent, not contract" problem (§3.5).

---

## 6. Proposed architecture

### 6.1 Form definition (content)

Built-in type templates, names reserved like the rest of `BUILTIN_TYPE_TEMPLATES`:

```
Form (kind: block)
  title            text      (localized)
  intro            richtext  (localized, optional)
  fields           contentArea  allowedBlocks: [FormTextField, FormEmailField,
                                FormTextareaField, FormNumberField, FormDateField,
                                FormSelectField, FormCheckboxField, FormRadioField,
                                FormConsentField, FormStaticText]
  submitLabel      text      (localized)
  confirmation     select    ["message", "redirect"]
  confirmationText richtext  (localized)     # when message
  redirectTo       link                      # when redirect
  notifyWebhooks   boolean                   # fire form.submitted
  retentionDays    number    (optional, 1–3650; empty = instance default)
  captureMetadata  boolean   (default false) # IP + user-agent, off by default (GDPR)
  spamProtection   select    ["heuristics", "heuristics+turnstile"]
```

Each field block carries the sub-schema its type needs — every one of these
already exists as a `FieldDef` capability, which is why this is cheap:

```
FormTextField
  name         text      # submission key; ^[a-zA-Z][a-zA-Z0-9_]*$
  label        text      (localized)
  helpText     text      (localized, optional)
  placeholder  text      (localized, optional)
  required     boolean
  minLength / maxLength / pattern      # -> FieldValidation
  patternMessage text    (localized)   # error copy authored by the editor
```

`FormConsentField` is deliberately its own type (Umbraco's "Data Consent" field
is the precedent): it renders an unticked checkbox, is always `required`, and
stores the consent text *as submitted* alongside the value — consent you can't
reproduce is consent you can't prove.

### 6.2 Delivery (read) — schema, never markup

The existing chokepoint already delivers blocks with `fieldTypes`; a `Form` block
therefore delivers as-is with no new contract. What must be added is a guarantee:
**field `name`, validation rules and error copy are public** for form field
blocks (they must reach the renderer), while `form_submission` data is never
delivered by any read path.

`@paperboycms/client` gains:
- `formSchema(block)` — normalises a delivered Form block into
  `{ fields: [{ name, type, label, required, rules, help, options }], submitLabel, confirmation }`.
- `submitForm(client, { formId, values, idempotencyKey })`.
- an optional `renderFormMarkup()` helper whose output is WCAG-2.2-correct by
  construction: `<label for>` on every control, `fieldset`/`legend` around
  radio/checkbox groups, `aria-describedby` for help and error text,
  `aria-invalid` on failures, an error summary that receives focus on submit, and
  required marked both visually and programmatically.

### 6.3 Submission (write) — a new, narrow surface

```
POST /delivery/forms/:documentId/submissions
  auth:    Authorization: Bearer <site public delivery key>   (D3)
  body:    application/json  { values: {...}, honeypot?: "", elapsedMs: number,
                               turnstileToken?: string }
  headers: Idempotency-Key: <uuid>   (optional but honoured)
  → 202 { ok: true, confirmation: {...} }
  → 422 { error: "validation", fields: { email: "Enter a valid email address" } }
  → 429 { error: "rate_limited" }
```

Non-negotiables, each traceable to a finding in §11:

- **A separate route module** (`apps/api/src/routes/submit.ts`) and a separate
  db-layer chokepoint (`submitForm()` in `packages/db/src/forms.ts`). The read
  chokepoint stays read-only; "delivery is GET-only" becomes "delivery reads are
  GET-only; submissions have their own write chokepoint", stated in CLAUDE.md.
- **The route must never read the session cookie.** CSRF tokens are meaningless
  without ambient credentials — but only as long as this path can't be reached
  *with* a cookie. Asserted by a test, so no future refactor can share a handler
  between the public and authenticated paths.
- **Server-side validation from the live definition** —
  `submissionSchemaFor(formBlock)` mirroring `dataSchemaFor`. Field-level,
  self-teaching errors (agent-API rule 2). This closes Payload's gap.
- **Unknown keys are rejected, not stored.** Garbage in → 422, never
  success-with-silent-drop (rule 1).
- **CORS**: echo the site's own `canonical_base_url` / `preview_base_url`
  origins. Never `*`, never with credentials.
- **Rate limits**: per IP *and* per form (`documentId`), so one abused form can't
  starve every other site's forms and one IP can't spray many forms.
- **Body cap** well under the global limit; no files (D6).
- **Idempotency**: `Idempotency-Key` + a unique index; a replay returns the
  original result instead of a duplicate row.

### 6.4 Storage

```sql
-- migration 0022_forms.sql (forward-only, additive)
CREATE TABLE form_submission (
  id             bigserial PRIMARY KEY,
  submission_id  text NOT NULL UNIQUE,        -- nanoid, the public handle
  site_id        text NOT NULL REFERENCES site(id),
  form_id        text NOT NULL,               -- content_item.document_id of the Form
  form_cv        bigint NOT NULL,             -- definition version at submit time
  locale         text NOT NULL,
  values         jsonb NOT NULL,              -- { fieldName: value }
  field_snapshot jsonb NOT NULL,              -- [{ name, label, type }] as submitted
  meta           jsonb NOT NULL DEFAULT '{}', -- { ip?, userAgent?, referer? } only if captureMetadata
  idempotency_key text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz                  -- NULL = keep until manually deleted
);
CREATE INDEX form_submission_form_idx ON form_submission (form_id, created_at DESC);
CREATE INDEX form_submission_site_idx ON form_submission (site_id, created_at DESC);
CREATE INDEX form_submission_expiry_idx ON form_submission (expires_at)
  WHERE expires_at IS NOT NULL;
CREATE UNIQUE INDEX form_submission_idem_idx ON form_submission (form_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

`field_snapshot` is the deliberate improvement on both Payload (rows referencing
mutable field definitions) and Strapi (a blob keyed by label, which breaks when a
label is edited): a submission stays readable and exportable exactly as it was
answered, whatever the editor does to the form afterwards.

### 6.5 Reading submissions (management)

- `GET /manage/forms/:documentId/submissions` — paginated, site-scoped through
  `AccessContext`, gated on a **new `submission.read` permission** (Admin +
  Editor by default; Author/Viewer no). Submissions are visitor PII, not content
  — they deserve their own permission rather than riding on `content.read`.
- `GET …/submissions.csv` — native export (Directus is the bar; Payload needing a
  second plugin is not). Export is audit-logged: the file is PII.
- `DELETE /manage/forms/:documentId/submissions/:submissionId` and
  `POST /manage/submissions/erase { email }` — the DSAR path: one audited action
  that removes every submission matching an identifier across the site.
- Admin UI: a "Submissions" tab on a Form document — list, detail drawer, export
  button, retention state, and a delete action. No new navigation concept.

### 6.6 Notifications

`form.submitted` joins the existing `WebhookEvent` union with
`{ event, formId, submissionId, siteId, locale, at, values? }` — `values`
included only when the subscription opts in, since the payload then carries PII
to a third party. Everything else (HMAC signature, SSRF guard, delivery log,
timeout) is inherited unchanged.

Phase 3 email seam, if built, follows the deliverability rules exactly: `From:`
our own authenticated domain, submitter in `Reply-To:`, and **every** value that
reaches a header stripped of CR/LF at one chokepoint — the display-name in
`From: "Name" <addr>` is as injectable as the address itself.

### 6.7 Retention (the differentiator)

- `expires_at` computed at insert from `retentionDays` (per form) or the instance
  default in `site_setting`.
- `runSubmissionRetention(db)` deletes expired rows, called from the **existing**
  boot + 60s ticker in `app.ts` — in-process, on by default. Umbraco's mistake
  (a policy that silently does nothing until someone enables a second task) is
  avoided by construction.
- Audit each sweep with a count, so deletion is provable.
- **Ops note**: the nightly `pg_dump` now contains visitor PII. `ops/README.md`
  needs a retention statement for backups too — a 14-day rotation of dumps means
  erased data survives up to 14 days there, which must be documented, and the
  DSAR response must say so.

---

## 7. Contract and test obligations

Per CLAUDE.md, these are not optional:

- `delivery-contract.test.ts` — snapshot the delivered `Form` block shape.
- `openapi-snapshot.test.ts` — the new routes are a public API surface.
- `mcp-parity.test.ts` — if MCP tools are added (§8 Phase 2), tool surface and
  self-teaching error shapes are pinned.
- `shared-*.test.ts` — `submissionSchemaFor` matrix: required, min/max, pattern +
  editor-authored message, select options, consent, unknown-key rejection.
- New `forms-submit.test.ts` — the security contract: cookie-bearing request is
  rejected/ignored; wrong site's key can't submit; honeypot filled → dropped;
  too-fast submit → dropped; over-limit → 429; replayed idempotency key → one
  row; unknown field → 422; private-by-default (submissions never appear in any
  delivery read).
- `apps/admin` e2e + axe for the Submissions tab; `apps/web` renders a real form
  end-to-end (the reference implementation is part of the deliverable).
- Coverage thresholds **ratchet up**, never down.
- **A `/security-review` pass is a merge gate for Phase 1.** First public write
  endpoint.

---

## 8. Phased implementation

> **What shipped:** strict inline-block validation; 11 built-in form types;
> `packages/shared/src/forms.ts` (spec + validator + heuristics); migration 0022
> + `packages/db/src/forms.ts`; `POST /delivery/forms/:id/submissions`;
> management list/detail/CSV/delete/erase routes; `submission.read` +
> `submission.manage`; the `form.submitted` webhook; the hourly retention sweep;
> six MCP tools; `@paperboycms/client` 0.3.0 (`submitForm`, `fieldAttrs`,
> `honeypotAttrs`, `formTimer`); the accessible reference renderer in apps/web;
> and the admin Submissions UI (tab on a Form + Settings → Form submissions).
> Tests: 33 unit + 27 endpoint/security, 923 API tests green, coverage gates met.

**Phase 0 — foundations (no user-visible forms yet)**
1. Strict validation of inline block payloads against the block type's own schema
   (closes the existing gap; benefits everything, not just forms).
2. `Form` + field block types as built-in type templates, with a "Contact form"
   recipe that instantiates the whole set.
3. `formSchema()` in `@paperboycms/client` + `fieldTypes` guarantee for form
   blocks. **At this point a frontend can already render a CMS-authored form and
   post it wherever it likes** — the headless-SaaS feature set, reached early.

**Phase 1 — submissions MVP (the value)**
4. `0022_forms.sql`; `packages/db/src/forms.ts` chokepoint; `submissionSchemaFor`.
5. `POST /delivery/forms/:id/submissions` with honeypot + fill-time heuristics,
   per-IP/per-form rate limits, idempotency, CORS from the site entity.
6. `submission.read` permission; management list + detail + CSV export + delete,
   all audited; Submissions tab in the admin.
7. `form.submitted` webhook event.
8. `apps/web` reference form; `submitForm()` in the client SDK; security review.

**Phase 2 — compliance and operations**
9. Retention: `expires_at`, `runSubmissionRetention`, instance default setting,
   audited sweeps, backup-retention documentation.
10. DSAR erase-by-email; export audit trail.
11. Turnstile (opt-in per form): server-side `siteverify`, single-use tokens
    (300s TTL), `idempotency_key` on retries, secret in `site_setting` encrypted
    with the same KEK as the AI keys.
12. MCP tools: `list_form_submissions`, `get_form_submission`,
    `export_form_submissions`, `create_form` (template instantiate) — RBAC
    inherited, writes audited with `ip='mcp'`.

**Phase 3 — reach (only if wanted)**
13. Email seam (Resend/SMTP) mirroring the AI provider seam, with autoresponder;
    DMARC-correct headers; CRLF chokepoint.
14. Conditional logic evaluated on both sides (D7).
15. File uploads with quarantine + signed URLs + AV (D6).
16. Multi-step, if there is a real use case.

**Acceptance test for the whole effort:** delete
`neoteric-src/src/pages/api/contact.ts` and the hardcoded contact markup, author
that form in Paperboy, and have submissions arrive in the CMS with the same
Turnstile protection and an email out via n8n.

---

## 9. Explicitly out of scope

Named so nobody "helpfully" adds them: file uploads (D6), conditional logic and
multi-step (D7), payments (Payload's payment field is a nice seam, but there is
no use case here), autoresponders before an email seam exists, a bespoke
drag-and-drop form designer (content areas already order fields), spam *scoring*
services (Akismet), and A/B testing of forms.

---

## 10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **First public write endpoint** | High | Separate route + chokepoint; no cookie path; validation from the live schema; rate limits; security-review gate; contract tests asserting the no-leak boundary |
| **Spam volume** | Medium | Honeypot + fill-time by default (free, accessible), Turnstile opt-in, per-form limits, and the submissions list makes abuse visible instead of silent |
| **PII in Postgres + nightly backups** | Medium | `captureMetadata` off by default (IP is personal data — *Breyer*), retention on by default, documented backup retention, DSAR erase action |
| **DB growth / query cost at scale** | Medium | Indexes on `(form_id, created_at)`; retention caps growth; Umbraco's perf issues came from over-fetching field data — never `SELECT *` the values blob for list views |
| **Editor confusion between form structure and locales** | Medium | D5 mitigation: warn when a locale's structure differs from the source |
| **Feature creep toward Gravity Forms** | Medium | §9 is the contract with ourselves |

---

## 11. Sources

**Prior art — .NET CMS**
Optimizely: [Forms overview](https://docs.developers.optimizely.com/content-management-system/docs/forms) ·
[Form element types](https://webhelp.optimizely.com/latest/en/content-cloud-for-editors/forms/form-element-types.htm) ·
[Headless Forms API](https://docs.developers.optimizely.com/content-management-system/v1.2.0-forms/docs/set-up-headless-optimizely-forms-api) ·
[Headless forms reloaded (beta)](https://world.optimizely.com/blogs/martin-ottosen/dates/2024/3/headless-forms-reloaded-beta/) ·
[Retention policies](https://docs.developers.optimizely.com/content-management-system/v1.2.0-forms/docs/customizing-retention-policies) ·
[Honeypot recipe (CodeArt)](https://www.codeart.dk/blog/2020/8/episerver-forms-avoiding-spam-with-a-honeypot/)
Umbraco: [Field types](https://docs.umbraco.com/umbraco-forms/editor/creating-a-form/fieldtypes) ·
[Headless/AJAX Forms](https://docs.umbraco.com/umbraco-forms/developer/ajaxforms) ·
[Forms in the database](https://docs.umbraco.com/umbraco-forms/developer/forms-in-the-database) ·
[Conditional logic](https://docs.umbraco.com/umbraco-forms/editor/creating-a-form/conditional-logic) ·
[Perf issue #1119](https://github.com/umbraco/Umbraco.Forms.Issues/issues/1119) ·
[CVE-2021-37334 analysis](https://appcheck-ng.com/umbraco-forms-file-upload-vulnerability-technical-analysis/)

**Prior art — open-source headless**
[Payload Form Builder plugin](https://payloadcms.com/docs/plugins/form-builder) ·
[Payload: no server-side validation (#50)](https://github.com/payloadcms/plugin-form-builder/issues/50) ·
[Strapi form-builder tutorial](https://strapi.io/blog/build-form-builder-with-strapi-and-nextjs) ·
[Directus dynamic forms](https://directus.com/docs/frameworks/nextjs/dynamic-forms) ·
[Directus import/export](https://directus.com/docs/guides/content/import-export) ·
[Keystone access control](https://keystonejs.com/docs/config/access-control)

**Prior art — headless SaaS**
[Sanity: Forms with Sanity](https://www.sanity.io/docs/developer-guides/forms-with-sanity) ·
[Storyblok: dynamic form (Next.js)](https://www.storyblok.com/tp/dynamic-form-storyblok-next-js-tailwind-css) ·
[Storyblok as a form builder](https://www.storyblok.com/tp/simple-dynamic-form-builder) ·
[Kontent.ai forms discussion (Luminary)](https://www.luminary.com/blog/online-web-forms-with-kontent-ai) ·
[Prismic: forms aren't built in](https://community.prismic.io/t/adding-a-form-to-prismic/14508)

**Security, privacy, accessibility**
[Cloudflare Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) ·
[OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) ·
[OWASP File Upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) ·
[Email header injection](https://www.invicti.com/learn/email-injection) ·
[IP addresses are personal data (Breyer)](https://techgdpr.com/blog/is-an-ip-address-considered-personal-data/) ·
[GDPR retention](https://usercentrics.com/knowledge-hub/gdpr-data-retention/) ·
[W3C WAI Forms Tutorial](https://www.w3.org/WAI/tutorials/forms/) ·
[WCAG 2.2 Understanding 3.3.1](https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html) ·
[reCAPTCHA accessibility](https://friendlycaptcha.com/insights/recaptcha-accessibility/) ·
[DMARC/SPF/DKIM alignment](https://dmarcly.com/blog/how-to-implement-dmarc-dkim-spf-to-stop-email-spoofing-phishing-the-definitive-guide)
