# Common Audit Workflow

Every skill in this pack follows the same outer workflow. Document once, reference from each SKILL.md.

## The 5 phases

### 1. Stack detection + scope

Before applying any check, identify what's actually in the target:
- Read `package.json` / `pyproject.toml` / `go.mod` / `Gemfile` / `pom.xml` / `*.csproj` to see dependencies.
- Look for framework signatures (`next.config.js`, `vite.config.ts`, `nest-cli.json`, `manage.py`, etc.).
- Detect auth provider (Clerk, NextAuth, Auth0, Supabase Auth) via imports/env vars.
- Detect ORM (Prisma, Drizzle, TypeORM, Mongoose, SQLAlchemy) via imports/schema files.

State the detected stack in the report header. If the user expected a different stack, surface that mismatch before continuing.

### 2. Inventory

Enumerate the surface this skill cares about (varies per skill — see each SKILL.md).

### 3. Detection

Apply the skill's checks. For each finding:
- Capture file path + line number
- Capture a minimal evidence snippet (never paste secrets)
- Tag with category, CWE, finding ID

### 4. Triage

Sort by severity (Critical → Info). Within severity, group by category.

### 5. Report

Emit to `audits/<skill-name>/<target>/<YYYY-MM-DD>.md` using the schema in `_shared/findings-schema.md`.

## Defaults that hold across skills

- **Read-only** by default; mutating actions require explicit user authorization.
- **Reproducible evidence** for every finding.
- **No phantom findings**: if a check can't be applied (missing access, ambiguous target), note "Not assessed" — don't silently omit.
- **Bilingual user**: write the report in the user's framing language (French / English).

## Multi-skill orchestration

When several skills activate for the same target (typical for modern stacks):
- Each skill runs phases 1-5 independently with its own ID prefix.
- The combined report concatenates findings; readers see a unified severity-sorted list.
- Skills don't duplicate work — if one skill emits a finding about CORS, another skill referring to CORS just cites the existing finding.

## When to halt mid-audit

- Active exploitation suspected (logs show suspicious activity, secrets exposed publicly) → surface immediately + propose containment.
- Scope explosion (user said "audit one app", you find 50 packages) → confirm before continuing.
- Required access missing → ask the user to skip or grant.
