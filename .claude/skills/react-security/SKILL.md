---
name: react-security
description: Security audit specific to React applications including dangerouslySetInnerHTML, dynamic href/src injection, ref escape hatches, useEffect/useState pitfalls, React Server Components vs Client Components boundary, hydration mismatches, context leakage, and React Router authorization patterns. Use this skill whenever the user mentions React, JSX, hooks, components, dangerouslySetInnerHTML, React Router, React 18+ features, RSC, useEffect, useState, Suspense, or asks "audit my React app", "is my React code safe", "XSS in React", "React security review". Trigger when the codebase contains React imports (`from 'react'`), JSX (`.jsx`/`.tsx`), or `react-dom`. Use this even when only one React-specific concept is mentioned.
---

# React Security Audit

Audit React application code for vulnerabilities specific to React's rendering model, hooks system, and component boundaries. Defensive find-and-fix.

## When this skill applies

- Reviewing React components (functional or class) for XSS sinks
- Auditing React Router or TanStack Router authorization patterns
- Reviewing React 18 / 19 features: Server Components, Server Actions, Suspense, transitions
- Auditing hooks for state-leak / closure-trap patterns
- Reviewing form handling, file uploads, third-party React integrations
- Checking hydration mismatches that could expose server-only data

Use other skills for: Next.js-specific concerns (`nextjs-security`), Vite build/config (`vite-security`), backend code (Node, Python, Go skills), auth providers (`clerk-security`, `nextauth-security`).

## Workflow

Follow `../_shared/audit-workflow.md`. React-specific notes below.

### Phase 1: Stack detection

Confirm:
- React version (16 vs 17 vs 18 vs 19 — behavior differs significantly)
- Routing library (React Router v6/v7, TanStack Router, custom)
- Build tool (Vite, Create React App, Next.js, Remix, custom Webpack)
- State management (Redux, Zustand, Jotai, Context API, TanStack Query)
- Form library (React Hook Form, Formik, native)

Different versions and tools have different security surfaces — note them in the report.

### Phase 2: Inventory

```bash
# Find React entry points
grep -rln 'from .react.' src/ | head
grep -rln 'ReactDOM.render\|createRoot' src/

# Find dangerous sinks
grep -rn 'dangerouslySetInnerHTML' src/
grep -rn 'innerHTML\|outerHTML\|document.write' src/
grep -rn 'eval(\|Function(\|setTimeout([^,)]*[\'\"]\|setInterval([^,)]*[\'\"]' src/

# Refs and DOM access (escape hatches)
grep -rn 'useRef\|createRef' src/ | head -50
grep -rn 'findDOMNode' src/

# Route definitions (authorization surface)
grep -rn 'createBrowserRouter\|<Route\|useNavigate\|<Routes' src/
```

### Phase 3: Detection — the checks

#### dangerouslySetInnerHTML

- **RCT-DSH-1** Every `dangerouslySetInnerHTML` usage reviewed. Content must come from a trusted source (your own constants, server-rendered Markdown post-sanitization) — never directly from user input or remote data without DOMPurify-grade sanitization.
- **RCT-DSH-2** When sanitizing, use DOMPurify or sanitize-html with conservative config (no allowing `<script>`, `<iframe>`, event handlers like `onclick`).
- **RCT-DSH-3** Markdown rendering libraries (react-markdown, marked) configured to disallow raw HTML unless explicitly needed; if allowed, output passed through DOMPurify.

```jsx
// BAD
<div dangerouslySetInnerHTML={{ __html: post.content }} />

// GOOD
import DOMPurify from 'isomorphic-dompurify';
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(post.content) }} />

// BETTER — render through a Markdown renderer that doesn't allow raw HTML
<ReactMarkdown disallowedElements={['script', 'iframe']}>
  {post.content}
</ReactMarkdown>
```

#### URL injection in href/src

- **RCT-URL-1** Anchor `href` from user input validated against `javascript:`, `data:`, `vbscript:` schemes.
- **RCT-URL-2** Image `src` and iframe `src` from user input similarly validated; iframes additionally sandboxed.
- **RCT-URL-3** Open-in-new-tab links use `rel="noopener noreferrer"` (or use Link components from frameworks that default to this).

```jsx
// BAD — javascript:alert(1) executes
<a href={userProvidedUrl}>Click</a>

// GOOD
function safeHref(url) {
  try {
    const u = new URL(url, window.location.origin);
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(u.protocol)) return '#';
    return u.toString();
  } catch { return '#'; }
}
<a href={safeHref(userProvidedUrl)}>Click</a>
```

#### Ref escape hatches

- **RCT-REF-1** `useRef` / `createRef` used to access DOM — review for direct DOM mutation with user content (essentially the same as innerHTML).
- **RCT-REF-2** `ref.current.innerHTML = ...` with any user data → finding.
- **RCT-REF-3** Third-party libraries given refs (chart libraries, editors) — confirm they don't expose user content as HTML.

#### React Server Components (React 19 / Next.js App Router)

- **RCT-RSC-1** Sensitive data (API keys, DB URLs, internal IDs) imported in Server Components must not be passed as props to Client Components — they'll serialize and ship to the browser.
- **RCT-RSC-2** Server-only modules use `import 'server-only'` to prevent accidental client import.
- **RCT-RSC-3** Client-only modules use `import 'client-only'` similarly.
- **RCT-RSC-4** Forms using Server Actions verify auth and CSRF — Server Actions are essentially RPC endpoints (see `nextjs-security` for App Router specifics).

#### Hydration mismatches

- **RCT-HYD-1** Server-rendered components don't include data the client shouldn't see (full user objects, internal IDs) even if the visible output is identical.
- **RCT-HYD-2** `suppressHydrationWarning` audited — common to hide real bugs that may include security-relevant divergence.
- **RCT-HYD-3** Conditional rendering on `typeof window !== 'undefined'` doesn't accidentally render server-secret data before the check.

#### Authorization in routes

- **RCT-AUTH-1** Protected routes check auth on render, not just on navigation. A user can land on `/admin` via direct URL — guard the component.
- **RCT-AUTH-2** Auth check is async-safe: while loading, render a loading state, not the protected content with `null` data (which often renders empty admin shells the user can interact with).
- **RCT-AUTH-3** Client-side auth is UX, not security. Server-side enforcement still required — flag any "auth is purely client-side" pattern.

```jsx
// BAD — protected content briefly flashes during auth check
function AdminPanel() {
  const { user } = useAuth();
  if (!user?.isAdmin) return <Navigate to="/" />;
  return <AdminTools />;
}

// BETTER
function AdminPanel() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <Loading />;
  if (!user?.isAdmin) return <Navigate to="/" replace />;
  return <AdminTools />;
}
```

But server-side enforcement is still required — the API endpoints behind AdminTools must check auth themselves.

#### State exposure

- **RCT-STATE-1** Redux/Zustand/Jotai stores serialized to localStorage / sessionStorage don't include secrets (tokens, PII).
- **RCT-STATE-2** Context Providers don't propagate secrets to subtrees that don't need them (one Provider for auth state, separate one for user profile, etc.).
- **RCT-STATE-3** DevTools (Redux DevTools, React DevTools) disabled or limited in production builds for sensitive apps.

#### Form handling

- **RCT-FORM-1** File uploads validate MIME type by magic bytes, not just `accept` attribute (which is client-side hint, bypassable).
- **RCT-FORM-2** Form submission to third-party endpoints validates target origin.
- **RCT-FORM-3** React Hook Form / Formik default values don't pre-fill sensitive fields (passwords, secrets) from another user's state.

#### Third-party scripts loaded via React

- **RCT-3P-1** `<script>` tags injected via `<Helmet>` / `next/script` / direct DOM follow the CSP / SRI requirements (see `saas-security-pack/saas-frontend-hardening`).
- **RCT-3P-2** React component libraries (chart libs, rich text editors) reviewed for known CVEs.

#### Common vulnerable patterns by library

- **RCT-LIB-1** `react-router-dom < 6.3.0` — known CVEs; bump.
- **RCT-LIB-2** `react-helmet` (unmaintained) — migrate to `react-helmet-async`.
- **RCT-LIB-3** `react-pdf < 7.7.3` — RCE via PDF.js bundled version; bump.
- **RCT-LIB-4** Old `react-scripts` (CRA, deprecated) — known supply chain risk; migrate to Vite or Next.
- **RCT-LIB-5** Markdown renderers without raw HTML disabled by default.

### Phase 4: Triage

Critical class examples:
- `dangerouslySetInnerHTML` with raw user input
- Server Component leaking secrets to Client Component props
- Route guard relying on client-only check while API endpoint also doesn't check
- `eval`/`Function` constructors with user-controlled input

### Phase 5: Report

Use `../_shared/findings-schema.md`. Prefix IDs with `RCT-`.

## References

- `references/jsx-xss-sinks.md` — Comprehensive list of XSS sinks specific to React, with patches per pattern
