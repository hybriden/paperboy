# Third-party security-audit skills

These skills under `.claude/skills/` (fastify-security, react-security,
vite-security, nodejs-express-security, web-platform-security,
websocket-security, plus `_shared/`) are vendored from the `appsec-stack-pack`
of:

  hlsitechio/claude-skills-security  (MIT License, Copyright (c) 2026 Hubert / HLSI Tech)
  https://github.com/hlsitechio/claude-skills-security
  pinned commit: b093c6e13c9664970360dcc6d5184bd73d74e049

They are INSTRUCTION-ONLY (SKILL.md + reference markdown) — no executable code,
no network calls — audited before install (2026-08-27): valid skill frontmatter,
defensive framing only, zero exfiltration/eval/exec, example.com placeholders in
the verification snippets.

Chosen because their modules map 1:1 onto Paperboy's stack (Fastify API, React 19
+ Vite admin, delivery/cookies/CSP, MCP/WebSocket bridge). Known gaps: no
Drizzle- or Zod-specific module (SQLi risk is low — Drizzle parameterizes; the
Node module carries injection coverage), and two supplementary refs point at a
`saas-security-pack` that is NOT vendored (fastify FST-JWT-3 JWT checklist;
findings-schema's "companion" note) — harmless dangling links; Paperboy uses
opaque sessions + HMAC preview tokens, not JWT.
