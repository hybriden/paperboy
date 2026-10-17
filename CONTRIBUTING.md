# Contributing

Thanks for helping. Paperboy is small enough that one person can hold it in their head,
and the rules below exist to keep it that way.

## Setup

Node 24 and pnpm 9 (`corepack enable` gives you the right pnpm).

```bash
pnpm install
docker compose up -d db
export DATABASE_URL=postgresql://paperboy:paperboy@localhost:5433/paperboy
pnpm db:seed
pnpm dev            # api :8091, admin :8090
```

Before you open a PR:

```bash
pnpm -r typecheck
pnpm lint
pnpm --filter @paperboy/api test
```

## The rules that matter

- **Bugfixes start with a failing test** that reproduces the exact report, on the same surface
  (API or MCP) with the same inputs. Confirm it fails, then fix, and the same test goes green
  in the same PR. No repro, no fix.
- **Never bypass a chokepoint.** Delivery reads go through one function with a `perspective`.
  Authorization lives in `packages/db`, deny-by-default. Coercion of agent input lives in
  `coerceFieldValue`. If your change needs a second path, the design is wrong.
- **Errors are self-teaching.** Name the field, the expected shape, and a copyable example.
  An agent reads only the error text.
- **Snapshots are contracts.** A failing `delivery-contract` or `openapi-snapshot` test means
  you changed a public surface. Review the diff and update it deliberately; never blind `--update`.
- **Coverage ratchets up only.** Thresholds in `apps/api/vitest.config.ts` are never lowered.
- **Migrations are forward-only.** Add a new numbered `.sql` in `packages/db/migrations/`.
- **Smallest change that fully works.** Walk the ladder in `CLAUDE.md` → Code quality before
  adding an abstraction, option or dependency.

Everything else, including the deploy-safety rules and the incidents behind each rule, is in
[`CLAUDE.md`](CLAUDE.md). Read it before touching deploy, auth, delivery or MCP.

## Pull requests

Branch off `main`, keep one topic per PR, and describe what changed and why. CI runs
typecheck, lint, the API suite with coverage, the published packages' tests, the quickstart
in a clean checkout, and the admin e2e suite. A green run is required to merge.

## Security

Do not open an issue for a vulnerability. See [`SECURITY.md`](SECURITY.md).
