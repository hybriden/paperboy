import { describe, expect, it } from "vitest";
import { overlayAnchor } from "./overlay-anchor.js";

// Placement of the anchored on-page card. The pane is the whole budget: the card
// opens at the click point, but a card that would hang past an edge is pulled
// back inside — nothing it holds may land where it cannot be reached.
describe("overlayAnchor", () => {
  const base = {
    rect: { x: 0, y: 0, w: 200, h: 40 },
    ox: 0,
    oy: 0,
    scale: 1,
    tx: 0,
    pane: { w: 900, h: 700 },
    cardW: 380,
    cardH: 200,
  };
  const bottom = (a: ReturnType<typeof overlayAnchor>, h: number) => a.card.top + h;

  it("opens just under the click point when there is room", () => {
    const a = overlayAnchor({ ...base, rect: { x: 100, y: 100, w: 200, h: 40 }, ox: 20, oy: 10 });
    expect(a.card.top).toBe(124); // 100 + 10 + 14
    expect(a.card.left).toBe(80); // 100 + 20 - 40
  });

  // The reported bug: the "Add block" palette is far taller than the old fixed
  // 340px allowance, so clicking an area chip low on the page put most of the
  // list below the pane — rendered, unscrollable, unreachable.
  it("keeps a TALL palette clicked near the bottom fully inside the pane", () => {
    const a = overlayAnchor({ ...base, rect: { x: 100, y: 600, w: 200, h: 40 }, oy: 20, cardH: 550 });
    expect(bottom(a, 550)).toBeLessThanOrEqual(700 - 8);
    expect(a.card.top).toBeGreaterThanOrEqual(8);
  });

  it("caps the card to the pane so its own body scrolls instead of overflowing", () => {
    expect(overlayAnchor({ ...base, pane: { w: 900, h: 700 } }).card.maxHeight).toBe(684);
    // A pane shorter than the card: still inside, still positive.
    const tiny = overlayAnchor({ ...base, pane: { w: 900, h: 260 }, cardH: 550 });
    expect(tiny.card.maxHeight).toBe(244);
    expect(tiny.card.top).toBe(8);
  });

  // Before the first measurement the height is unknown. Assuming the worst (a
  // full-height card) keeps the very first paint inside the pane; assuming a
  // small one would flash the card off the bottom edge and then correct.
  it("treats an unmeasured card as full height", () => {
    const a = overlayAnchor({ ...base, rect: { x: 0, y: 600, w: 200, h: 40 }, cardH: 0 });
    expect(a.card.top).toBe(8);
  });

  it("clamps horizontally to the pane as well", () => {
    const right = overlayAnchor({ ...base, rect: { x: 880, y: 10, w: 20, h: 20 } });
    expect(right.card.left).toBe(900 - 380 - 8);
    const left = overlayAnchor({ ...base, rect: { x: 0, y: 10, w: 20, h: 20 } });
    expect(left.card.left).toBe(8);
  });

  it("scales the ring from the iframe's own pixels into pane coordinates", () => {
    const a = overlayAnchor({ ...base, rect: { x: 100, y: 200, w: 300, h: 50 }, scale: 0.5, tx: 30 });
    expect(a.ring).toEqual({ left: 30 + 50, top: 100, width: 150, height: 25 });
  });
});
