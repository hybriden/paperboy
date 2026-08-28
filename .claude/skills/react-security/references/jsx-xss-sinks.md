# JSX XSS Sinks Reference

Load this when reviewing React code for XSS — going beyond `dangerouslySetInnerHTML` to less obvious vectors.

## React's default safety

React auto-escapes everything in JSX text and attribute values:

```jsx
<div>{userContent}</div>           // ✓ escaped
<div title={userContent}>...</div>  // ✓ escaped
<input value={userContent} />       // ✓ escaped
```

The XSS surface is what bypasses or escapes this default.

## The explicit bypass — `dangerouslySetInnerHTML`

The name is the warning. Every usage requires verification that input is trusted or sanitized.

```jsx
// Common pattern for rich text from a CMS
<article dangerouslySetInnerHTML={{ __html: post.body }} />
```

Risk levels:
- `post.body` is your CMS content with admin-only authoring + sanitization at write time → **Low** (verify the write-side sanitization is actually there)
- `post.body` is user-generated and not sanitized → **Critical**
- `post.body` came from a Markdown renderer with raw HTML disabled → **Low** (verify the renderer config)

Mitigation patterns:

```jsx
import DOMPurify from 'isomorphic-dompurify';

// Browser-safe sanitizer; isomorphic-dompurify works in SSR too
const clean = DOMPurify.sanitize(post.body, {
  ALLOWED_TAGS: ['p', 'a', 'strong', 'em', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'code', 'pre', 'blockquote'],
  ALLOWED_ATTR: ['href', 'title', 'class'],
  ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
});
<article dangerouslySetInnerHTML={{ __html: clean }} />
```

For Markdown, prefer rendering through a safe library that never produces dangerous output:

```jsx
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';

<ReactMarkdown
  rehypePlugins={[rehypeSanitize]}
  components={{
    a: ({ node, ...props }) => <a {...props} rel="noopener noreferrer" />,
  }}
>
  {post.body}
</ReactMarkdown>
```

`react-markdown` with `rehype-sanitize` is the well-trodden safe path.

## Attribute injection — URL-bearing attributes

JSX escaping prevents tag injection in attributes, but doesn't prevent dangerous *values* in URL-bearing attributes.

```jsx
// User submits: javascript:alert(document.cookie)
<a href={user.website}>Click</a>
// Renders: <a href="javascript:alert(document.cookie)">Click</a>
// Clicking executes the script in the page origin.
```

Affected attributes:
- `href` (anchor, link, area)
- `src` (img, iframe, embed, source, video, audio, script — though React refuses script src changes)
- `srcdoc` (iframe)
- `data` (object)
- `action` (form, button formaction)
- `formaction` (input/button)
- `background` (legacy body, table)
- `poster` (video)

Validator:

```ts
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'sms:']);

export function safeUrl(input: unknown, fallback = '#'): string {
  if (typeof input !== 'string') return fallback;
  try {
    const u = new URL(input, typeof window !== 'undefined' ? window.location.origin : 'https://placeholder');
    return SAFE_PROTOCOLS.has(u.protocol) ? u.toString() : fallback;
  } catch {
    return fallback;
  }
}

// Usage
<a href={safeUrl(user.website)}>Website</a>
<img src={safeUrl(profile.avatarUrl, '/default-avatar.png')} alt="avatar" />
```

React 16.9+ logs a warning for `javascript:` URLs but still renders them. Don't rely on the warning.

## Style attribute — CSS injection

```jsx
// User submits: { 'background': 'url(javascript:alert(1))' }  -- rare modern, but still
<div style={user.style} />
```

CSS XSS is largely a relic in modern browsers (most blocked), but CSS exfiltration via attribute selectors is real (CSS can leak via `background-image: url(...)` containing a tracking endpoint).

If you must accept user CSS:
- Allowlist properties (typography, layout, color — not `background-image`, `content`, custom properties used for theming).
- Parse and re-emit through a CSS parser (PostCSS) rather than passing strings through.

## `key` prop is escaped, not "trusted"

```jsx
{items.map(item => <li key={item.id}>{item.label}</li>)}
```

`key` values aren't rendered — they're React-internal. But if an attacker can force key collisions across renders, they can manipulate component state (cause one user's state to render for another). Watch for keys like `user.email` or other attacker-controlled identifiers in lists that span trust boundaries.

## `__html` is the only `__`-prefixed bypass

React refuses other unknown props with `__` prefix. So `dangerouslySetInnerHTML={{__html: ...}}` is the only sanctioned bypass via the props system. But:

## Ref escape hatch

```jsx
function Comp() {
  const ref = useRef();
  useEffect(() => {
    ref.current.innerHTML = userContent;  // ⚠ bypasses React
  }, [userContent]);
  return <div ref={ref} />;
}
```

This bypasses React's escaping entirely. Treat any `ref.current.innerHTML = ...` (or `.insertAdjacentHTML`, `.outerHTML`, `.appendChild` of a parsed fragment) as a manual XSS sink. Same mitigation as `dangerouslySetInnerHTML`: sanitize.

Same goes for `findDOMNode` (deprecated) and direct DOM manipulation.

## Third-party libraries that may inject

### Chart libraries

Some accept HTML in tooltips:

```jsx
<Chart options={{
  tooltip: {
    formatter: (point) => `<b>${point.userName}</b>: ${point.value}`,
  }
}} />
```

If `point.userName` is user-controlled, tooltips become XSS. Either:
- Use string-based formatters (most modern libraries support both)
- Pre-sanitize all data passed into tooltip formatters
- Pick a chart library that escapes by default

### Rich text editors

Quill, TipTap, Slate, Draft.js, Lexical — each has its own model. Audit:
- Output rendering (when displaying saved content, sanitize HTML server-side and client-side)
- Paste handling (clipboard paste can include arbitrary HTML)
- Embed handling (videos, iframes) — usually allowlist sources

### Markdown to React (besides react-markdown)

`marked`, `markdown-it`, `showdown`: by default may allow raw HTML. Configure to disable, then output through `<div dangerouslySetInnerHTML>` with a final DOMPurify pass.

### Translation libraries

`react-i18next` and similar can render HTML when using `<Trans>` with `tOptions={{ interpolation: { escapeValue: false } }}` or `dangerouslySetInnerHTML` in translations. Audit any translation key referenced by user content.

## DOM event handlers from data

```jsx
// User-controlled `onClick` via data — unusual but seen in builders / no-code platforms
<button onClick={user.onClick}>Click</button>
// If user.onClick is a string, React treats it as a function and ignores; safe.
// But:
<button onClick={() => eval(user.code)}>Run</button>  // explicit eval — never
<button onClick={new Function(user.code)}>Run</button>  // same
```

`eval` and `new Function` with user input are direct RCE in the browser context. The pattern shows up in low-code / no-code builders and in component playgrounds.

## SSR-specific sinks

When using SSR (Next.js, Remix, custom Node SSR):

- **Server-side `dangerouslySetInnerHTML`** with user content → still XSS, executed in user's browser.
- **`__html` containing JSON for hydration** — common pattern is `<script id="__NEXT_DATA__" type="application/json">{json}</script>`. If JSON isn't escaped to prevent `</script>` injection, script breakout possible. Frameworks handle this; custom SSR may not.

```jsx
// BAD — custom SSR with raw JSON
<script id="data" type="application/json"
  dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />

// GOOD — escape forward slashes and HTML-sensitive chars
function safeJsonForScript(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
```

Next.js uses safe serialization automatically for `getServerSideProps` returns. Custom solutions may not.

## Detection checklist

For each component file:

1. Grep for `dangerouslySetInnerHTML` — review every occurrence.
2. Grep for `innerHTML\|outerHTML\|insertAdjacentHTML` — same.
3. Grep for `eval\|new Function\|setTimeout\(.*['"]\|setInterval\(.*['"]` — review.
4. Grep for `<a href={` / `<iframe src={` / `<img src={` — confirm URL validator if value is dynamic.
5. List Markdown / rich text rendering — confirm sanitization or safe library config.
6. List third-party components receiving user data — confirm escape behavior.
7. For SSR — confirm JSON serialization is script-safe.
8. Check translation library config — auto-escape on by default.

## Patches summary

| Sink | Fix |
|------|-----|
| `dangerouslySetInnerHTML` with raw user data | DOMPurify.sanitize() or use react-markdown + rehype-sanitize |
| Dynamic `href`/`src` from user | safeUrl() validator above |
| `ref.current.innerHTML` | Same sanitization as dangerouslySetInnerHTML |
| `eval` / `new Function` with user input | Refactor — almost never legitimate; use safe expression evaluators |
| Translation with HTML | Disable raw HTML in translations; use components |
| Chart tooltips | String formatters or pre-sanitize input |
| SSR script JSON | Use `safeJsonForScript` helper |
