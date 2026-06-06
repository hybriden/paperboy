# MCP usability eval

A small, scheduled eval that drives the Paperboy MCP server with a **real
model** through a realistic editorial task, then verifies the outcome
programmatically.

## What this measures (vs the parity suite)

| | `apps/api/test/mcp-parity.test.ts` | `evals/mcp-eval.mjs` (this) |
|---|---|---|
| Locks the | **contract** | **usability** |
| Question | Given exact arguments, do the tools behave identically to the REST API? | Can a real model, reading only the tool descriptions + schemas, get the job done? |
| Driver | Hardcoded calls (deterministic) | The Anthropic Messages API (a real model loop) |
| Fails when | A tool's behavior or surface changes | A tool **description** silently stops steering the model (model drift) |

The parity tests can stay green while this goes red: that's the point. When it
fails, the **scorecard prints the tool errors the model hit verbatim, with the
tool name** — that is the signal showing exactly which tool description stopped
working.

## What it does

1. Spawns the real stdio MCP server (`apps/mcp`, `tsx src/server.ts`) against
   the DB at `DATABASE_URL`, authenticated as the seed admin.
2. `tools/list` → converts the MCP tools to Anthropic tool-use format.
3. Runs a real agent loop (up to 15 iterations): model → execute each
   `tool_use` via the MCP client → return `tool_result` → until the model stops.
   The task: *create a blog post under the Blog list page, write a short
   markdown body, set a summary, and publish it* (it must find the Blog page via
   the `tree` tool — no seed ids are hardcoded).
4. **Verifies outcomes programmatically** (never trusting the model): using the
   MCP client directly, it asserts the post exists under the Blog parent
   (`tree`), is published (`delivery_get_by_id` with `preview:false` returns it
   only if a published variant exists), and has a non-empty markdown body and
   summary.
5. Prints a scorecard and exits **0 only if all assertions pass**, non-zero
   otherwise.

Dependency-free beyond Node built-ins + global `fetch`. No SDK installs.

## ⚠️ This eval MUTATES whatever DB you point it at

`DATABASE_URL` is the database the MCP server (and this eval) **write to** — it
creates and publishes a blog post there. Point it at a throwaway/test DB, never
production. In CI it runs against a dedicated `paperboy_eval` service container.

## Run locally

```bash
# 1. Make sure a test DB is seeded (the test DB the API suite uses):
export PATH="$HOME/.npm-global/bin:$PATH"
DATABASE_URL=postgresql://paperboy:paperboy@localhost:5433/paperboy_test \
SEED_ADMIN_EMAIL=admin@paperboy.test SEED_ADMIN_PASSWORD='Admin!Passw0rd' \
PAPERBOY_PUBLIC_KEY=pk_live_test_public PAPERBOY_PREVIEW_KEY=prv_test_preview \
  pnpm --filter @paperboy/db seed

# 2. Run the eval (real model loop — needs an API key):
DATABASE_URL=postgresql://paperboy:paperboy@localhost:5433/paperboy_test \
ANTHROPIC_API_KEY=sk-ant-... \
  node evals/mcp-eval.mjs
```

> Point `DATABASE_URL` at the **already-seeded** test DB
> (`postgresql://paperboy:paperboy@localhost:5433/paperboy_test`). The local
> api/admin/web dev servers also use this DB; the eval adding one published post
> to it is harmless.

### Dry run (no API key)

Validates everything except the model loop — spawns the MCP server, lists the
tools, prints the converted Anthropic tool schemas, and runs the outcome
assertions against a non-existent post so they fail cleanly:

```bash
DATABASE_URL=postgresql://paperboy:paperboy@localhost:5433/paperboy_test \
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

```
  Assertions:
    PASS  Blog parent page found via tree  (NFcNg87iKfokn-Hqn8BYIPe0)
    PASS  post exists under Blog parent  (documentId=…)
    PASS  post is PUBLISHED (delivery, preview=false)  (delivered on the published perspective)
    PASS  post has a non-empty markdown body  (412 chars)
    PASS  post has a non-empty summary  (67 chars)

  Model loop: stop_reason=end_turn, iterations=6
  Tool calls made:
      2x  set_field
      1x  tree
      ...
  Tool errors the model hit (THE SIGNAL — which description stopped working):
    (none — every tool call the model made succeeded)

  RESULT: PASS (5/5 assertions)
```

- **Assertions** — the programmatic outcome checks. All must pass for exit 0.
- **Tool calls made** — names + counts. A spike (e.g. 9× `set_field`) usually
  means the model got stuck in a retry loop on a tool that stopped steering it.
- **Tool errors** — the most important section. Each error is printed with its
  tool name and (truncated) args. If the model hit errors but still recovered,
  the assertions may pass — but the errors tell you a description is degrading.
  If the assertions fail, these errors are where to look first.

## CI

`.github/workflows/eval.yml` runs this weekly (Mondays 06:00 UTC) and on
`workflow_dispatch`. It seeds a dedicated Postgres `paperboy_eval` service and
runs the eval. If the `ANTHROPIC_API_KEY` secret is not configured the job exits
green with a notice (so forks / unconfigured repos don't show a red failure).
It is intentionally **not** on every push — it calls the paid Anthropic API.
