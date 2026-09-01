/** Gap kept between the card and every pane edge. */
const GAP = 8;
/** The card hangs just under the click so it never covers what you clicked. */
const BELOW_CLICK = 14;
/** Nudge left of the click, so the card's body sits under the pointer. */
const LEFT_OF_CLICK = 40;

export interface OverlayAnchorInput {
  /** Element box as the bridge reports it: the iframe's own CSS px, pre-scale. */
  rect: { x: number; y: number; w: number; h: number };
  /** Click point inside that element, pre-scale — preserved as the page scrolls. */
  ox: number;
  oy: number;
  /** Preview scale, and the stage's horizontal offset within the pane. */
  scale: number;
  tx: number;
  /** The pane the card must stay inside. */
  pane: { w: number; h: number };
  cardW: number;
  /** MEASURED card height. 0 = not measured yet. */
  cardH: number;
}

export interface OverlayAnchor {
  ring: { left: number; top: number; width: number; height: number };
  card: { left: number; top: number; maxHeight: number };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

/**
 * Where the anchored on-page card goes, in pane coordinates.
 *
 * The card opens at the CLICK POINT inside the element the bridge reported, and
 * is then pulled back inside the pane on both axes. The vertical pull is the
 * whole point: the card's content is not a fixed size — the "Add block" palette
 * lists every type an area allows — so its height is MEASURED and the pane
 * caps it. A constant allowance is what put the palette's tail below the fold.
 */
export function overlayAnchor(i: OverlayAnchorInput): OverlayAnchor {
  const ring = {
    left: i.tx + i.rect.x * i.scale,
    top: i.rect.y * i.scale,
    width: i.rect.w * i.scale,
    height: i.rect.h * i.scale,
  };
  const clickX = i.tx + (i.rect.x + i.ox) * i.scale;
  const clickY = (i.rect.y + i.oy) * i.scale;
  // The card can never exceed the pane — its own body scrolls instead — so the
  // height used for the clamp is bounded too. Unmeasured (0) assumes the worst,
  // which keeps the FIRST paint inside the pane rather than flashing off the
  // bottom edge and correcting a frame later.
  const maxHeight = Math.max(0, i.pane.h - GAP * 2);
  const height = i.cardH > 0 ? Math.min(i.cardH, maxHeight) : maxHeight;
  return {
    ring,
    card: {
      left: clamp(clickX - LEFT_OF_CLICK, GAP, i.pane.w - i.cardW - GAP),
      top: clamp(clickY + BELOW_CLICK, GAP, i.pane.h - height - GAP),
      maxHeight,
    },
  };
}
