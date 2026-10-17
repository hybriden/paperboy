## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] Bugfix: a test reproduces the reported failure and failed before the fix
- [ ] `pnpm -r typecheck`, `pnpm lint` and `pnpm --filter @paperboy/api test` pass locally
- [ ] Snapshot changes (`delivery-contract`, `openapi-snapshot`) are deliberate and reviewed
- [ ] Public surface changes bump the npm package version and its README
- [ ] New write paths that change delivered output announce `delivery.changed`
