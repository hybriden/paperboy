# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through
[GitHub's private vulnerability reporting](https://github.com/hybriden/paperboy/security/advisories/new).
You will get an acknowledgement within 3 working days and a fix or a plan within 14 days
for anything that affects a default install.

Include what you can: the affected surface (admin, Management API, Delivery API, MCP),
steps to reproduce, and the impact you see. A proof of concept against your own instance
is welcome; please do not test against instances you do not own.

## Supported versions

Only the `main` branch and the latest `ghcr.io/hybriden/paperboy-app` image receive fixes.
Published npm packages (`@paperboycms/client`, `@paperboycms/preview`) are fixed in their
latest minor.

## What counts

In scope: authentication and session handling, RBAC and site partitioning, the delivery
no-leak chokepoint, CSRF, SSRF in webhooks and uploads, the MCP and OAuth surfaces, and
anything that lets a visitor or a delivery key reach drafts or private fields.

Out of scope: issues that require the committed dev secrets (`setup.sh` replaces them and
the API refuses to boot on them), rate-limit bypass that needs a distributed source, and
reports from automated scanners with no reproduction.

## How the project defends itself

Every write path (admin, REST, MCP) shares one validation, authorization and audit layer.
Secrets are rejected at boot if they match the committed placeholders. Workflow actions are
SHA-pinned and bumped by Dependabot. Secret scanning and push protection are on. The rules
behind each of these, with the incidents that produced them, are in [`CLAUDE.md`](CLAUDE.md).
