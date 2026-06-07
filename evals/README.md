# MCP outcome-invariant eval

Drives the Paperboy MCP server with a **real model** through several realistic
editorial **scenarios**, then asserts **outcome invariants** on every document
the model produced — the things a human would otherwise have to eyeball in
production.

## Why this exists

Every content incident this project hit was the same shape: the system accepted
a write into a state that is *technically valid* but *defeats the author's
intent*, and a **human in production** was the one who noticed. Regression tests
prevent each exact bug from returning — but they don't find the **next** one.
This eval moves detection left: a real model runs the real workflows, and the
harness checks intent, so CI becomes the detector instead of you.

## What this measures (vs the parity suite)

| | `apps/api/test/mcp-parity.test.ts` | `evals/mcp-eval.mjs` (this) |
|---|---|---|
| Locks the | **contract** | **outcome** |
| Question | Given exact arguments, do the tools behave like the REST API? | Can a real model, reading only the tool descriptions, land a GOOD OUTCOME? |
| Driver | Hardcoded calls (deterministic) | The Anthropic Messages API (a real model loop) |
| Fails when | A tool's behavior/surface changes | A model produces content that is unreachable / invisible / wrong-branch / placeholder-named / empty |

The parity tests can stay green while this goes red: that's the point.

## The outcome invariants (run on EVERY produced document)

| Invariant | Catches the incident |
|---|---|
| **reachable** — `urlPath ≠ null` | "No URL yet" / empty after translate |
| **real name** — not `Untitled` | the post published at `/untitled` titled "Untitled" |
| **published** — a published variant exists | drafts the model thought it published |
| **visible where meant** — child type === parent list page `listedType` | BlogPosts created under the ArticlePage `Projects` list (published but invisible) |
| **complete** — at least one non-empty field | the article published without its body |
| **right branch** (per scenario) — published in the intended locale | a Norwegian article published on the English blog |

Because the universal checks run on *every* doc a scenario produces, the net
also catches failures nobody wrote a specific assertion for.

## Scenarios

| id | Workflow | Key invariant exercised |
|---|---|---|
| `blog-post` | create a blog post under Blog, body + summary, publish | reachable / published / complete |
| `projects` | create an article under the `Projects` list page (created in setup, lists `ArticlePage`) | **visible where meant** (type must match listedType) |
| `norwegian` | lag en norsk artikkel under Blog | **right branch** (published on `nb`, not `en`) |

Each scenario: snapshot page ids → run setup (deterministic, not the model) →
run the model loop → discover the docs the model produced → assert invariants.

Dependency-free beyond Node built-ins + global `fetch`. No SDK installs.

## ⚠️ This eval MUTATES whatever DB you point it at

`DATABASE_URL` is the database the MCP server (and this eval) **write to** — it
creates and publishes content and a `Projects` list page there. Point it at a
throwaway/test DB, never production. In CI it runs against a dedicated
`paperboy_eval` service container.

## Run locally

```bash
export PATH="$HOME/.npm-global/bin:$PATH"

# 1. Seed an ISOLATED eval DB (never your prod/live DB):
DATABASE_URL=postgresql://paperboy:paperboy@localhost:5433/paperboy_eval_local \
SEED_ADMIN_EMAIL=admin@paperboy.test SEED_ADMIN_PASSWORD='Admin!Passw0rd' \
PAPERBOY_PUBLIC_KEY=pk_live_test_public PAPERBOY_PREVIEW_KEY=prv_test_preview \
  pnpm --filter @paperboy/db seed

# 2. Run the eval (real model loop — needs an API key):
DATABASE_URL=postgresql://paperboy:paperboy@localhost:5433/paperboy_eval_local \
ANTHROPIC_API_KEY=sk-ant-... \
  node evals/mcp-eval.mjs

# One scenario only:
ANTHROPIC_API_KEY=sk-ant-... DATABASE_URL=... node evals/mcp-eval.mjs --only=projects
```

### Dry run (no API key)

Validates the harness without the model: spawns the MCP server, lists tools,
detects locales, and runs each scenario's setup (e.g. creates the `Projects`
list page) so you can confirm the plumbing.

```bash
DATABASE_URL=postgresql://paperboy:paperboy@localhost:5433/paperboy_eval_local \
  node evals/mcp-eval.mjs --dry-run
```

## Env vars

| Var | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | — | The DB the MCP server + eval mutate. |
| `ANTHROPIC_API_KEY` | yes (unless `--dry-run`) | — | Drives the model loop. |
| `EVAL_MODEL` | no | `claude-haiku-4-5-20251001` | Model that drives the loop. |
| `MCP_EMAIL` | no | `admin@paperboy.test` | Seed admin login the MCP acts as. |
| `MCP_PASSWORD` | no | `Admin!Passw0rd` | Seed admin password. |

## Reading the scorecard

Each scenario prints the model's stop reason, the tool errors it hit (the
steering signal — which description degraded), and per-document PASS/FAIL for
every invariant. A scenario fails if it produced nothing, or any produced doc
fails any invariant. `OVERALL: PASS` only if every scenario passed.

## Two drivers: mock (free) vs real model

The outcome invariants test the **system**, not the model — so they don't need
a real model to catch a regression, only a realistic sequence of writes. So
there are two drivers:

| Driver | Flag | Cost | What it's for |
|---|---|---|---|
| **mock** | `--mock` | free, deterministic, no API key | A scripted transcript of real MCP tool calls per scenario. Gates **every push**. Catches every SYSTEM regression (the 14 incidents). |
| **real model** | (default) | paid Anthropic API | A real model loop. Tests tool-description **drift** — only a model can. Runs **weekly + on demand**. |

Both run the identical invariant net, so a mock failure and a real failure read
the same.

## CI

`.github/workflows/eval.yml` chooses the driver from the trigger:

- **push / PR to `main`** → `--mock` (deterministic, **no API calls, no cost**) —
  this is the proactive gate.
- **schedule (Mondays 06:00 UTC) / `workflow_dispatch`** → the real model. If the
  `ANTHROPIC_API_KEY` secret is not configured it exits green with a notice (so
  forks / unconfigured repos don't show red).
