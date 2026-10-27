# @paperboycms/preview

The browser-side **on-page-editing bridge** for the [Paperboy](https://github.com/hybriden/paperboy) headless CMS preview iframe. Framework-agnostic, **zero runtime dependencies**.

It is the single source of truth for the message protocol between the CMS admin (parent window) and a frontend rendered inside the preview iframe — so frontends and the admin can't drift.

**Changes in 0.8.0**: `paperboy:focus` takes an optional `path` (the same `{field, blockIndex}` steps `paperboy:edit` reports), so the admin can point at one exact block when several areas or nested areas share an index. With a path, an empty `field` flashes the block itself. An older bridge ignores `path` and keeps using `blockIndex`.

**Changes in 0.6.0** — supports inserting blocks at a specific position (`index?: number` on `paperboy:drop` and `paperboy:add-block`), displays an insertion indicator line during drag-over, and positions the "Add block" chip between blocks on hover.

**Changes in 0.5.0** — tracks anchored elements when opening overlays (such as the Add block palette) and re-emits `paperboy:rect` updates throttled by `requestAnimationFrame` on preview scroll/resize so anchored overlays follow their targets; stops tracking when receiving `paperboy:rect` with `rect: null`.

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

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `parentOrigin` | — | Origin of the embedding admin, or a list of them (0.9+). Recommended — see below |
| `target` | `window.parent` | Window to post messages to |
| `doc` | `document` | Document to bind to (tests, a different frame) |
| `accent` | `#0077BC` | Outline/highlight colour |
| `badge` | `true` | Show the "Preview — click to edit" badge. It is click-transparent and fades out after a few seconds; the outlines carry the mode from there |

### Sender trust (read this)

`paperboy:patch` applies `element.innerHTML = …`, so the bridge's message handler is
an HTML injection sink. It therefore **only accepts messages whose `event.source` is
the window it posts to** (the parent, or your `target`). A message with a foreign
source — or none at all — is ignored. This matters because framing rules don't cover
it: any page can `window.open(previewUrl)` and postMessage into the handle it gets
back without ever embedding you.

`parentOrigin` is optional and additive, but without it any page that frames the
preview can drive it, so the bridge logs a console warning (0.9+). Setting it:
- requires inbound messages to come from that exact origin (or one in the list), and
- addresses outbound messages to it instead of `"*"`, so field text and caret
  snippets can't be delivered to some other origin.

More than one admin previews this frontend? Pass them all:
`parentOrigin: ["https://cms.example.com", "https://staging-cms.example.com"]`.
Outbound messages then go to the parent's own origin where the browser reports it
(`location.ancestorOrigins`), otherwise to each listed origin.

Pair it with a `frame-ancestors` CSP that lists the same admin origins, so no other
site can frame the preview at all.

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
- posts `paperboy:edit` when an editable region is clicked (with rect/click/caret and optional hierarchical `path` for nested blocks, v0.7+),
- posts `paperboy:drop` (with optional `index` and hierarchical `path` for nested areas, v0.7+) when a shared block/page is dragged from the Assets pane onto a `data-pb-area`,
- streams `paperboy:rect` on scroll/resize, applies `paperboy:patch` (live swap) and `paperboy:focus`,
- outlines every `data-pb-area` with a dotted border (v0.4+) so editors see where
  each content area starts and ends; hovering an area shows its name and a
  "＋ Add block" chip that posts `paperboy:add-block {field, rect, index?, path?}` (v0.7+), which the admin
  answers by opening its block palette for that area, anchored at the chip. The
  chrome is `position:fixed` elements injected into `<body>` — never DOM inside
  your area elements, so grid/flex layouts are untouched. Older admins ignore the
  message; the chip hides while a block drag is in progress,
- injects its own styles and persists scroll across reloads.

## Protocol subpath — types only, no DOM

`@paperboycms/preview/protocol` is the contract itself: constants, message types and
builders, nothing that touches a document. The admin (parent window) imports it;
a frontend imports it to spell the attribute names.

```ts
import { ATTR, DRAG_MIME, PROTOCOL_VERSION, parsePreviewMessage, patchMessage, focusMessage } from "@paperboycms/preview/protocol";
```

| Export | What it is |
| --- | --- |
| `ATTR` | The attribute names — `field`, `area`, `blockIndex`, `blockType`. Spell markers through it (`{ [ATTR.field]: "title" }`) so your markup can't drift from the bridge |
| `DRAG_MIME` | `application/x-paperboy` — the `dataTransfer` type of an Assets-pane drag |
| `PROTOCOL_VERSION` | `1` — carried by `paperboy:preview-ready` |
| `parsePreviewMessage(data)` | Narrows an untrusted `MessageEvent.data` to the typed union, or `null` (unknown type, or a non-integer `blockIndex` / `index`) |
| `patchMessage` `focusMessage` `dragSourceMessage` `dragEndMessage` `dragAtMessage` `dropAtMessage` `pingMessage` | Builders for the admin → iframe messages |
| Types | `FromPreview` = `ReadyMessage` \| `EditMessage` \| `RectMessage` \| `DropMessage` \| `AddBlockMessage`; `ToPreview` = `PatchMessage` \| `FocusMessage` \| `DragSourceMessage` \| `DragEndMessage` \| `DragAtMessage` \| `DropAtMessage` \| `PingMessage`; `PaperboyMessage`, `Rect`, `Caret` |

`parsePreviewMessage(ev.data)` narrows an incoming message to the typed union (or `null` for unknown/garbage — the protocol is additive-only and both ends ignore unknown types, so independently-deployed admin/frontends degrade gracefully).

## Attribute contract

The names are exported as `ATTR` from the protocol subpath (above); prefer that
over hand-writing them.

| Attribute | Meaning |
| --- | --- |
| `data-pb-field` | An editable field region (value = field name) |
| `data-pb-area` | A content area that accepts block drops (value = field name) |
| `data-pb-block-index` / `data-pb-block-type` | A rendered block inside an area |
| `data-pb-field` inside a block root | That block's own field (v0.3+): `paperboy:edit` carries field + blockIndex, and `paperboy:patch` / `paperboy:focus` accept an optional `blockIndex` scoping the live swap / highlight to that block (focus falls back to flashing the block root when the field isn't tagged) |

⚠️ `data-pb-area`'s value must be the contentArea **field name** — the bridge posts it back to the editor as `paperboy:drop {field}` (and `paperboy:add-block {field}`), which looks the field up on the content type. A boolean-ish marker (`data-pb-area="true"`) makes every drop fail; the bridge warns about it in the console. Prefer spreading `pbAreaAttrs(field, preview)` from `@paperboycms/client` instead of writing the attribute by hand (it also keeps public pages marker-free).
