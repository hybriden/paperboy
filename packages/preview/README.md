# @paperboycms/preview

The browser-side **on-page-editing bridge** for the [Paperboy](https://github.com/hybriden/paperboy) headless CMS preview iframe. Framework-agnostic, **zero runtime dependencies**.

It is the single source of truth for the message protocol between the CMS admin (parent window) and a frontend rendered inside the preview iframe — so frontends and the admin can't drift.

## Frontend (inside the preview iframe)

Call `initPreviewBridge()` once, only in preview, and mark your editable DOM:

```ts
import { initPreviewBridge } from "@paperboycms/preview";

if (inPreviewMode) {
  const teardown = initPreviewBridge();
}
```

```html
<h1 data-pb-field="heading">…</h1>
<div data-pb-field="contentarea" data-pb-area="contentarea">
  <!-- each rendered block: -->
  <section data-pb-block-index="0" data-pb-block-type="CardBlock">…</section>
</div>
```

The bridge then:
- posts `paperboy:edit` when an editable region is clicked (with rect/click/caret),
- posts `paperboy:drop` when a shared block/page is dragged from the Assets pane onto a `data-pb-area`,
- streams `paperboy:rect` on scroll/resize, applies `paperboy:patch` (live swap) and `paperboy:focus`,
- injects its own styles and persists scroll across reloads.

## Admin (parent window) — types only, no DOM

```ts
import { parsePreviewMessage, patchMessage, focusMessage } from "@paperboycms/preview/protocol";
```

`parsePreviewMessage(ev.data)` narrows an incoming message to the typed union (or `null` for unknown/garbage — the protocol is additive-only and both ends ignore unknown types, so independently-deployed admin/frontends degrade gracefully).

## Attribute contract

| Attribute | Meaning |
| --- | --- |
| `data-pb-field` | An editable field region (value = field name) |
| `data-pb-area` | A content area that accepts block drops (value = field name) |
| `data-pb-block-index` / `data-pb-block-type` | A rendered block inside an area |
