# A/B testing: research and decisions

Editors test one part of a page against alternatives, visitors are split
between them, conversions are counted, and the winner is published. Issue
#125 holds the full research; this records what we chose and why. Code:
`packages/shared/src/experiments.ts` (assignment + statistics),
`packages/db/src/experiments.ts` (the rules), `apps/api/src/routes/experiments.ts`,
and the counting in `apps/api/src/routes/{traffic,submit}.ts`.

Words: an **experiment** has **versions** A (the control) to D. "Variant"
already means a language branch in Paperboy and is never used for this.

## What others do

- Most headless CMSs (Strapi, Sanity, Payload, Directus, Hygraph) store the
  alternatives and leave assignment and statistics to GrowthBook, PostHog,
  LaunchDarkly or Ninetailed.
- Built in: Storyblok and Umbraco Engage (whole page), Builder.io, Uniform and
  Sitecore XM Cloud (component), Sanity (field). Assignment is a sticky cookie
  or a deterministic hash of visitor and experiment (Optimizely MurmurHash,
  GrowthBook FNV-1a). Builder.io deletes losing versions; we don't.
- Nobody swaps content in the browser after load: it flickers. The version is
  picked on the server or at the edge.
- Vercel no longer caches responses with `Vary: Cookie`; pages under test are
  `Cache-Control: private` or carry the version in the cache key.
- [Google](https://developers.google.com/search/docs/crawling-indexing/website-testing):
  no cloaking (Googlebot sees what a cookieless visitor sees), `rel=canonical`
  to the original, 302 for redirect tests, run only as long as necessary.
- [Evan Miller](https://www.evanmiller.org/how-not-to-run-an-ab-test.html):
  stopping when a result first looks significant ("peeking") gives ~26 % false
  positives instead of 5 %. Sample size per version n ≈ 16·p(1−p)/δ².
- Sample ratio mismatch (SRM): χ² against the configured split, flag at p < 0.001.
- Norway: ekomloven §3-15 (from 1.1.2025). Nkom and Datatilsynet have exempted
  neither analytics nor A/B cookies, so a cookie remembering the version needs
  consent. Only France (CNIL) has an explicit, conditional A/B exemption.

## Decisions

**B1. An experiment tests one content area** of one page in one locale (the
hero, a CTA, block order). Version A is the page's published area, B–D are
alternative block lists, at most four versions. At most one running or paused
experiment per area; several areas per page are allowed.

**B2. Own tables** (`experiment`, `experiment_arm`, `experiment_stat`,
migration 0033), not a dimension on `content_version`, whose two unique
indexes on `(document_id, locale)` every read depends on. Version blocks pass
the same validation as an area on the page (coercion, schema, allowed blocks,
reference targets). A running experiment's versions can't be edited: pause it.

**B3. Delivery ships the versions, the frontend picks.** A page delivered with
a running experiment carries `experiments: [{id, area, arms: [{key, weight,
blocks?}]}]`; the area itself stays the control and version A carries no
blocks. Additive: an old frontend shows the control. One response, so ETag and
CDN caching work unchanged; the experiment's own `cv` folds into the ETag so
starting or stopping one changes it. Every version is sanitized like the area,
counts against the 500-node budget, and SEO, JSON-LD, sitemap and llms are
always computed from the control. Preview also ships draft and paused
experiments, so the admin can show any version (`?pbab=<id>:<arm>`).

**B4. Deterministic assignment, one implementation.** `assignArm(experimentId,
visitorKey, arms)`: FNV-1a over `experimentId:visitorKey`, 10 000 buckets,
cumulative weights. In `packages/shared` and `@paperboycms/client`, pinned
equal by a test. No visitor key → version A, for robots too; the user agent is
never inspected, so there is no cloaking.

**B5. Two privacy modes per site; cookieless is the default.**
- Cookieless: the version is drawn per page view and nothing is stored on the
  device. Only goals on the same page (a form on it) can be attributed, and the
  admin says so plainly.
- Consent: the frontend sets a first-party `pb_vid` (random id, at most 13
  months) only after the site's consent signal. Sticky assignment and goals
  across pages. The docs say consent is required; it is never called
  "strictly necessary".
- Either way Paperboy stores no IP, user agent or visitor id: counts per day.

**B6. Counting extends `POST /delivery/traffic`** with `exposures` and
`conversions` (100 each): public key only, no cookie read, rate-limited per
key, upserted into `experiment_stat (experiment, arm, day)`. An unknown or
ended experiment is ignored and counted in the reply, never an error, so a
cached page can't fail. A form submission may carry `experiments: [{id, arm}]`
and counts as a conversion for experiments whose goal is `form`; nothing about
it is stored on the submission.

**B7. Honest statistics** (`packages/shared/src/experiments.ts`): the editor
gives today's conversion rate and the smallest relative lift worth detecting;
the admin shows n per version and an estimated duration. Each version is
compared with A by a two-proportion z-test with a 95 % interval for the
difference. **No winner is declared before every version reaches n**: until
then the verdict is "not conclusive yet: 420 of 3 100" (rule 1: never a false
success). SRM is a warning. Bayesian, sequential, bandits and CUPED are out.

**B8. Ending with a winner is a normal edit.** The winner's blocks are written
into the area as a draft through `updateContent` (coercion, revision,
needs-review as usual); "publish" does that and publishes, and needs
`content.publish`. Losing versions stay with their results. Start, pause and
end announce `delivery.changed` with reason `experiment`.

**B9. The experiment follows the page.** A ticker ends experiments at `ends_at`
(no winner; the page returns to the control) and ends any whose page was
unpublished, trashed or moved to another site, or whose area left the content
type, recording why. The dashboard warns past the site's limit (default 30
days).

**B10. Permissions.** Read: `content.read`. Create and edit drafts:
`content.update`, section-scoped, so an Author can prepare one. Start, pause,
end, winner: `content.publish`. Everything is audit-logged
(`experiment.create|update|start|pause|end`). An experiment created over MCP
is `needs_review`; with agent review on, an agent can't start it and is told a
human must; a human starting it is the review.

## Open questions, answered with the issue's proposals

1. Cookieless by default, with honest limits: **yes**.
2. Authors prepare experiments (`content.update`): **yes**; starting needs `content.publish`.
3. Four versions and one experiment per area: **enough for v1**.
4. "Publish winner" in one step: **yes**, next to "winner as draft".

## Out of scope (v1)

Personalization and segments; multivariate tests; single-field tests;
split-URL and whole-page tests (later as "version = another page" with 302 and
canonical); Bayesian or sequential statistics and bandits; cross-site
experiments; built-in GA4 or PostHog sending (the client hands back exposures
to forward); A/B tests of forms themselves.
