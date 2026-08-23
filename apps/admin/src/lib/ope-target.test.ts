import { describe, expect, it } from "vitest";
import { opeAction } from "./ope-target.js";

/**
 * What an on-page click DOES.
 *
 * The rule that matters: on-page editing is a mode the editor chose from the
 * toolbar, so an incoming click must never change it. Clicking a content area —
 * which is what "clicking outside a property" resolves to, because the click
 * bubbles to the nearest tagged ancestor — used to drop the whole editor into
 * side-by-side, yanking the page out from under them (reported 2026-08-23).
 */
describe("opeAction — on-page (edit) mode", () => {
  const edit = { mode: "edit" as const, hasRect: true };

  it("opens the overlay on an editable page field", () => {
    expect(opeAction({ ...edit, blockIndex: null, fieldName: "heading", pageFieldType: "text" }))
      .toEqual({ kind: "overlay", target: "page" });
  });

  it("opens the overlay on the page name, which is not a data field", () => {
    expect(opeAction({ ...edit, blockIndex: null, fieldName: "name", pageFieldType: undefined }))
      .toEqual({ kind: "overlay", target: "name" });
  });

  it("opens the overlay on an editable field inside a block", () => {
    expect(opeAction({ ...edit, blockIndex: 2, fieldName: "title", blockFieldType: "text" }))
      .toEqual({ kind: "overlay", target: "block" });
  });

  it("STAYS on a content area — the click that used to teleport", () => {
    // A click on page background bubbles to the nearest [data-pb-field], which
    // is usually the content area wrapping the blocks.
    expect(opeAction({ ...edit, blockIndex: null, fieldName: "mainArea", pageFieldType: "contentArea" }))
      .toEqual({ kind: "stay" });
  });

  it("STAYS on a reference, and on any other field not editable in place", () => {
    expect(opeAction({ ...edit, blockIndex: null, fieldName: "related", pageFieldType: "reference" }))
      .toEqual({ kind: "stay" });
    expect(opeAction({ ...edit, blockIndex: null, fieldName: "legacy", pageFieldType: "media" }))
      .toEqual({ kind: "stay" });
  });

  it("STAYS on a marker that names no field at all", () => {
    expect(opeAction({ ...edit, blockIndex: null, fieldName: "notAField", pageFieldType: undefined }))
      .toEqual({ kind: "stay" });
  });

  it("STAYS with a hint when a BLOCK click can only be handled in the form", () => {
    // A deliberate click on a block deserves an explanation; a stray background
    // click (above) deserves silence.
    expect(opeAction({ ...edit, blockIndex: 1, fieldName: "items", blockFieldType: "contentArea" }))
      .toEqual({ kind: "stay", hint: "form-only" });
    // A shared block resolves no block field — it is edited on its own page.
    expect(opeAction({ ...edit, blockIndex: 1, fieldName: "title", blockFieldType: undefined }))
      .toEqual({ kind: "stay", hint: "form-only" });
  });

  it("STAYS when the bridge sent no rect — there is nothing to anchor to", () => {
    expect(opeAction({ mode: "edit", hasRect: false, blockIndex: null, fieldName: "heading", pageFieldType: "text" }))
      .toEqual({ kind: "stay" });
  });

  it("never returns the view-switching action in edit mode", () => {
    const cases = [
      { blockIndex: null, fieldName: "mainArea", pageFieldType: "contentArea" },
      { blockIndex: null, fieldName: "x", pageFieldType: undefined },
      { blockIndex: 3, fieldName: "y", blockFieldType: "contentArea" },
      { blockIndex: 3, fieldName: "y", blockFieldType: undefined },
    ] as const;
    for (const c of cases) {
      expect(opeAction({ ...edit, ...c }).kind, JSON.stringify(c)).not.toBe("sidebar");
    }
  });
});

describe("opeAction — inspect mode is unchanged", () => {
  const inspect = { mode: "inspect" as const, hasRect: true };

  it("routes every click to the sidebar, which is the point of inspect mode", () => {
    expect(opeAction({ ...inspect, blockIndex: null, fieldName: "heading", pageFieldType: "text" }))
      .toEqual({ kind: "sidebar" });
    expect(opeAction({ ...inspect, blockIndex: null, fieldName: "mainArea", pageFieldType: "contentArea" }))
      .toEqual({ kind: "sidebar" });
    expect(opeAction({ ...inspect, blockIndex: 2, fieldName: "title", blockFieldType: "text" }))
      .toEqual({ kind: "sidebar" });
  });
});
