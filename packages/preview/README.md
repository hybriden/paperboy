# @paperboycms/preview

The browser-side **on-page-editing bridge** for the [Paperboy](https://github.com/hybriden/paperboy) headless CMS preview iframe. Framework-agnostic, **zero runtime dependencies**.

It is the single source of truth for the message protocol between the CMS admin (parent window) and a frontend rendered inside the preview iframe — so frontends and the admin can't drift.

## Frontend (inside the preview iframe)

Call `initPreviewBridge()` once, only in preview, and mark your editable DOM:

```ts
import { initPreviewBridge } from "@paperboycms/preview";

if (inPreviewMode) {
  const teardown = initPreviewBridge({
    // RECOMMENDED: the origin of the admin that embeds this preview.
    parentOrigin: "https://cms.example.com",
  });
}
```

### Sender trust (read this)

`paperboy:patch` applies `element.innerHTML = …`, so the bridge's message handler is
an HTML injection sink. It therefore **only accepts messages whose `event.source` is
the window it posts to** (the parent, or your `target`). A message with a foreign
source — or none at all — is ignored. This matters because framing rules don't cover
it: any page can `window.open(previewUrl)` and postMessage into the handle it gets
back without ever embedding you.

`parentOrigin` is optional and additive. Setting it:
- requires inbound messages to come from that exact origin, and
- addresses outbound messages to it instead of `"*"`, so field text and caret
  snippets can't be delivered to some other origin.

**Mount the bridge in preview mode only.** On a published page it would be a live
`innerHTML` sink for the lifetime of every visitor's session.

```html
<h1 data-pb-field="heading">…</h1>
<div data-pb-field="contentarea" data-pb-area="contentarea">
  <!-- each rendered block: -->
  <section data-pb-block-index="0" data-pb-block-type="CardBlock">
    <!-- fields INSIDE a block (v0.3+): tag them and the bridge reports the field
         together with the enclosing block index, so the editor opens its
         on-page overlay scoped to this block instance -->
    <h3 data-pb-field="title">…</h3>
  </section>
</div>
```

The bridge then:
- answers `paperboy:ping` with `paperboy:preview-ready` (v0.3.2+), so the admin can
  confirm the bridge is alive at any moment instead of relying on catching the
  one-shot announcement it posts at init,
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
| `data-pb-field` inside a block root | That block's own field (v0.3+): `paperboy:edit` carries field + blockIndex, and `paperboy:patch` / `paperboy:focus` accept an optional `blockIndex` scoping the live swap / highlight to that block (focus falls back to flashing the block root when the field isn't tagged) |

⚠️ `data-pb-area`'s value must be the contentArea **field name** — the bridge posts it back to the editor as `paperboy:drop {field}`, which looks the field up on the content type. A boolean-ish marker (`data-pb-area="true"`) makes every drop fail; the bridge warns about it in the console. Prefer spreading `pbAreaAttrs(field, preview)` from `@paperboycms/client` instead of writing the attribute by hand (it also keeps public pages marker-free).
