# Shared Findings Schema — AppSec Stack Pack

All skills in this pack emit findings in the same structure. See the companion `saas-security-pack` for the original schema; this file is the local copy with the prefix table for THIS pack's 31 skills.

## Severity rubric

| Level | Use when |
|-------|----------|
| **Critical** | Unauthenticated RCE, mass data exfiltration vector, tenant breach, hardcoded production secret in public source, auth bypass with no MFA |
| **High** | Authenticated privilege escalation, IDOR exposing other tenants' data, SSRF reaching internal services, JWT validation bypass |
| **Medium** | XSS requiring user interaction, CSRF on state-changing endpoints, weak rate limiting, outdated dep with CVE but no public exploit, permissive CORS |
| **Low** | Missing security header with compensating control, verbose error message, hygiene issue |
| **Info** | Best-practice deviation with no direct exploitability, observability gap |

## Finding template

```markdown
### [SEV] Short finding title

- **ID**: `<skill-prefix>-<NNN>`
- **Severity**: Critical | High | Medium | Low | Info
- **Category**: <domain tag>
- **CWE**: CWE-XXX (when applicable)
- **Affected**: `<file:line>` or `<resource identifier>`
- **Evidence**:
  ```
  <minimal snippet — never include real secrets>
  ```
- **Why it matters**: 1-3 sentences tying CWE to the affected resource.
- **Remediation**:
  ```
  <copy-pasteable fix>
  ```
- **Verification**: How to confirm the fix worked.
- **References**: Links to vendor docs, CWE, OWASP, RFC.
```

## Report header

```markdown
# <Skill Name> — Audit Report

- **Target**: <repo/project/resource>
- **Stack detected**: <e.g., Next.js 14 + Prisma + Clerk>
- **Scope**: <what was reviewed, what was excluded>
- **Date**: YYYY-MM-DD
- **Auditor**: <skill name + version>

## Summary

| Severity | Count |
|----------|-------|
| Critical | N     |
| High     | N     |
| Medium   | N     |
| Low      | N     |
| Info     | N     |

## Findings
```

## Skill ID prefixes

### Frontend
| Skill | Prefix |
|-------|--------|
| react-security | RCT |
| nextjs-security | NXT |
| vite-security | VIT |
| vue-nuxt-security | VUE |
| svelte-sveltekit-security | SVK |
| angular-security | ANG |
| electron-security | ELC |

### Backend (Node)
| Skill | Prefix |
|-------|--------|
| nodejs-express-security | NDE |
| nestjs-security | NST |
| fastify-security | FST |
| hono-security | HNO |

### Backend (Python)
| Skill | Prefix |
|-------|--------|
| django-security | DJG |
| fastapi-security | FAP |
| flask-security | FLK |

### Backend (other)
| Skill | Prefix |
|-------|--------|
| go-security | GOL |
| rails-security | RLS |
| laravel-security | LRV |
| spring-boot-security | SPR |
| dotnet-aspnetcore-security | DNC |

### API protocols
| Skill | Prefix |
|-------|--------|
| graphql-security | GQL |
| trpc-security | TRP |
| websocket-security | WSC |

### Data layer
| Skill | Prefix |
|-------|--------|
| prisma-orm-security | PRI |
| mongoose-mongodb-security | MNG |
| redis-security | RDS |

### Auth providers
| Skill | Prefix |
|-------|--------|
| clerk-security | CLK |
| nextauth-security | NXA |

### Edge / Cloud
| Skill | Prefix |
|-------|--------|
| vercel-platform-security | VRC |
| cloudflare-workers-security | CFW |
| aws-lambda-security | AWL |

### Web platform
| Skill | Prefix |
|-------|--------|
| web-platform-security | WPS |

## Multi-skill audit pattern

When a target uses several covered technologies, multiple skills activate. The combined report concatenates findings from each, prefixed by the skill ID. Example for a Next.js + Prisma + Clerk app:

```
NXT-001  Critical  Server action without auth check
PRI-003  High      Raw query with unsanitized input
CLK-002  High      Webhook signature not verified
NXT-007  Medium    Public env var leaks API URL
PRI-008  Medium    Mass assignment on user-controlled fields
```

This makes triage manageable across stacks.

## Triage advice

Critical findings are remediable independently — never block a Critical fix on a structural High that takes weeks. If a Critical finding depends on a structural change, split it into (a) immediate mitigation (disable endpoint, rotate secret) and (b) the structural fix as a separate High.
