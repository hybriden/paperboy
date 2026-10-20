// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initPreviewBridge } from "./bridge.js";
import { DRAG_MIME } from "./protocol.js";

// postMessage is redeclared as a plain mock PROPERTY (not Window's method) so
// tests can reference it unbound — `expect(target.postMessage)` — without tripping
// no-unbound-method, while the value still satisfies the `target?: Window` option.
interface MockWindow extends Window {
  postMessage: ReturnType<typeof vi.fn>;
}
const makeTarget = (): MockWindow => ({ postMessage: vi.fn() }) as unknown as MockWindow;

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.body.className = "";
});

describe("initPreviewBridge", () => {
  it("activates editing chrome, announces ready, and tears down cleanly", () => {
    const target = makeTarget();
    const teardown = initPreviewBridge({ target });
    expect(document.body.classList.contains("pb-editing")).toBe(true);
    expect(document.querySelector("style[data-pb-bridge]")).not.toBeNull();
    expect(target.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "paperboy:preview-ready" }), "*");
    teardown();
    expect(document.body.classList.contains("pb-editing")).toBe(false);
    expect(document.querySelector("style[data-pb-bridge]")).toBeNull();
  });

  it("is idempotent: a second init returns the existing teardown and stacks nothing", () => {
    // A second call stacked styles, badge, chrome and listeners — every click
    // then posted paperboy:edit twice.
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-field="heading">Hi</div>`;
    const first = initPreviewBridge({ target, badge: false });
    const second = initPreviewBridge({ target, badge: false });
    expect(second).toBe(first);
    expect(document.querySelectorAll("style[data-pb-bridge]")).toHaveLength(1);
    target.postMessage.mockClear();
    document.querySelector("[data-pb-field]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(target.postMessage).toHaveBeenCalledTimes(1);
    first();
    expect(document.querySelector("style[data-pb-bridge]")).toBeNull();
    // After teardown, init is a fresh bridge again.
    const third = initPreviewBridge({ target, badge: false });
    expect(third).not.toBe(first);
    third();
  });

  it("posts paperboy:edit when an editable region is clicked", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-field="heading">Hi</div>`;
    const teardown = initPreviewBridge({ target, badge: false });
    target.postMessage.mockClear();
    document.querySelector("[data-pb-field]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(target.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "paperboy:edit", field: "heading" }), "*");
    teardown();
  });

  it("posts field + enclosing blockIndex when a field INSIDE a block is clicked", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <section data-pb-block-index="2" data-pb-block-type="HeroBlock">
        <h2 data-pb-field="title">Hi</h2>
      </section>`;
    const teardown = initPreviewBridge({ target, badge: false });
    target.postMessage.mockClear();
    document.querySelector("[data-pb-field]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(target.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "paperboy:edit", field: "title", blockIndex: 2, blockType: "HeroBlock" }),
      "*",
    );
    teardown();
  });

  it("paperboy:patch with blockIndex only touches the field inside THAT block", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <section data-pb-block-index="0"><h2 data-pb-field="title">A</h2></section>
      <section data-pb-block-index="1"><h2 data-pb-field="title">B</h2></section>`;
    const teardown = initPreviewBridge({ target, badge: false });
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "paperboy:patch", field: "title", text: "X", blockIndex: 1 }, source: target }),
    );
    const [a, b] = Array.from(document.querySelectorAll("[data-pb-field='title']"));
    expect(a!.textContent).toBe("A");
    expect(b!.textContent).toBe("X");
    // Without blockIndex the first page-wide match is patched (pre-0.3 behavior).
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "paperboy:patch", field: "title", text: "Y" }, source: target }),
    );
    expect(a!.textContent).toBe("Y");
    teardown();
  });

  it("paperboy:focus with blockIndex highlights the field inside THAT block, falling back to the block root", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <section data-pb-block-index="0"><h2 data-pb-field="title">A</h2></section>
      <section data-pb-block-index="1"><h2 data-pb-field="title">B</h2></section>
      <section data-pb-block-index="2"><p>untagged fields</p></section>`;
    const teardown = initPreviewBridge({ target, badge: false });
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "paperboy:focus", field: "title", blockIndex: 1 }, source: target }),
    );
    const [a, b] = Array.from(document.querySelectorAll("[data-pb-field='title']"));
    expect(a!.classList.contains("pb-focus")).toBe(false);
    expect(b!.classList.contains("pb-focus")).toBe(true);
    // A field the markup doesn't tag → the block root itself flashes.
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "paperboy:focus", field: "intro", blockIndex: 2 }, source: target }),
    );
    expect(document.querySelector("[data-pb-block-index='2']")!.classList.contains("pb-focus")).toBe(true);
    teardown();
  });

  it("answers paperboy:ping with preview-ready (liveness probe)", () => {
    const target = makeTarget();
    const teardown = initPreviewBridge({ target, badge: false });
    target.postMessage.mockClear();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:ping" }, source: target }));
    expect(target.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "paperboy:preview-ready" }), "*");
    // Repeatable: the admin may probe several times while it waits.
    target.postMessage.mockClear();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:ping" }, source: target }));
    expect(target.postMessage).toHaveBeenCalledTimes(1);
    teardown();
  });

  it("outlines content areas in editing mode (region visibility)", () => {
    const target = makeTarget();
    const teardown = initPreviewBridge({ target, badge: false });
    // The injected stylesheet must draw the area's extent — a dotted outline,
    // distinct from the dashed field outline — so editors see start/end.
    const css = document.querySelector("style[data-pb-bridge]")!.textContent!;
    expect(css).toMatch(/\[data-pb-area\][^{]*\{[^}]*dotted/);
    teardown();
  });

  it("hovering a content area shows its name tag + an add chip; leaving hides them", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-area="mainArea"><p id="inner">block</p></div><p id="outside">not an area</p>`;
    const teardown = initPreviewBridge({ target, badge: false });
    const tag = document.querySelector<HTMLElement>(".pb-area-tag")!;
    const add = document.querySelector<HTMLElement>(".pb-area-add")!;
    expect(tag).not.toBeNull();
    expect(add).not.toBeNull();
    expect(tag.style.display).toBe("none");
    document.getElementById("inner")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    expect(tag.style.display).not.toBe("none");
    expect(tag.textContent).toBe("mainArea");
    expect(add.style.display).not.toBe("none");
    document.getElementById("outside")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    expect(tag.style.display).toBe("none");
    expect(add.style.display).toBe("none");
    teardown();
  });

  it("hovering the chip itself keeps the chrome (it sits outside the area element)", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-area="mainArea"><p id="inner">block</p></div>`;
    const teardown = initPreviewBridge({ target, badge: false });
    document.getElementById("inner")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    const add = document.querySelector<HTMLElement>(".pb-area-add")!;
    // Moving the pointer onto the chip fires pointerover with the chip as
    // target — that must not read as "left the area" or it vanishes mid-click.
    add.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    expect(add.style.display).not.toBe("none");
    teardown();
  });

  it("a drag hides the add chip — a visible chip would swallow the drop", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-area="mainArea"><p id="inner">block</p></div>`;
    const teardown = initPreviewBridge({ target, badge: false });
    document.getElementById("inner")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    const add = document.querySelector<HTMLElement>(".pb-area-add")!;
    expect(add.style.display).not.toBe("none");
    // Cross-origin path: the admin broadcasts the drag start.
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:dragsource", payload: { kind: "block" } }, source: target }));
    expect(add.style.display).toBe("none");
    // Same-origin path: a dragover carrying our MIME hides it too.
    document.getElementById("inner")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    expect(add.style.display).not.toBe("none");
    const dt = { types: ["application/x-paperboy"], dropEffect: "", getData: () => "" };
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(over, "dataTransfer", { value: dt });
    document.getElementById("inner")!.dispatchEvent(over);
    expect(add.style.display).toBe("none");
    teardown();
  });

  it("clicking the add chip posts paperboy:add-block with the area's field", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-area="mainArea"><p id="inner">block</p></div>`;
    const teardown = initPreviewBridge({ target, badge: false });
    document.getElementById("inner")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    target.postMessage.mockClear();
    document.querySelector<HTMLElement>(".pb-area-add")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(target.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "paperboy:add-block", field: "mainArea", rect: expect.anything() }),
      "*",
    );
    teardown();
  });

  it("teardown removes the area chrome", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-area="mainArea"></div>`;
    const teardown = initPreviewBridge({ target, badge: false });
    expect(document.querySelector(".pb-area-add")).not.toBeNull();
    teardown();
    expect(document.querySelector(".pb-area-add")).toBeNull();
    expect(document.querySelector(".pb-area-tag")).toBeNull();
  });

  it("posts paperboy:drop with the area's field + parsed payload on drop", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-area="contentarea"><p>empty</p></div>`;
    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc1", blockType: "CardBlock" };
    const dt = { types: ["application/x-paperboy"], dropEffect: "", getData: () => JSON.stringify(payload) };
    const ev = new Event("drop", { bubbles: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    document.querySelector("[data-pb-area] p")!.dispatchEvent(ev);
    expect(target.postMessage).toHaveBeenCalledWith({ type: "paperboy:drop", field: "contentarea", payload }, "*");
    teardown();
  });

  it("drops using the admin-broadcast payload when dataTransfer is empty (cross-origin)", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-area="contentarea"><p>empty</p></div>`;
    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc9", blockType: "HeroBlock" };
    // Admin broadcasts the drag source (cross-origin: dataTransfer would be hidden).
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:dragsource", payload }, source: target }));
    // Drop with NO readable dataTransfer data (getData returns "").
    const dt = { types: [] as string[], dropEffect: "", getData: () => "" };
    const ev = new Event("drop", { bubbles: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    document.querySelector("[data-pb-area] p")!.dispatchEvent(ev);
    expect(target.postMessage).toHaveBeenCalledWith({ type: "paperboy:drop", field: "contentarea", payload }, "*");
    teardown();
  });

  it("drops via paperboy:drop-at — hit-tests the content area under the pointer (cross-origin overlay path)", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-area="contentarea"><p id="inner">empty</p></div>`;
    const inner = document.getElementById("inner")!;
    // happy-dom doesn't implement elementFromPoint; stub it to the area's child.
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => inner;
    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc7", blockType: "CardBlock" };
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:drop-at", x: 50, y: 60, payload }, source: target }));
    expect(target.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "paperboy:drop", field: "contentarea", payload }),
      "*",
    );
    teardown();
  });

  it("calculates insertion index 0 when dropping above a block's midpoint", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div data-pb-area="mainArea">
        <div id="b0" data-pb-block-index="0">Block 0</div>
      </div>
    `;
    const b0 = document.getElementById("b0")!;
    // b0 bounds: top 100, height 100 -> midpoint is 150
    b0.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 10, right: 310, width: 300, height: 100, x: 10, y: 100 } as DOMRect);

    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc1", blockType: "CardBlock" };

    // Dragover at y=120 (above midpoint 150)
    const dt = { types: ["application/x-paperboy"], dropEffect: "", getData: () => JSON.stringify(payload) };
    const overEv = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(overEv, "dataTransfer", { value: dt });
    Object.defineProperty(overEv, "clientY", { value: 120 });
    b0.dispatchEvent(overEv);

    // Drop at y=120
    const dropEv = new Event("drop", { bubbles: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt });
    Object.defineProperty(dropEv, "clientY", { value: 120 });
    b0.dispatchEvent(dropEv);

    expect(target.postMessage).toHaveBeenCalledWith(
      { type: "paperboy:drop", field: "mainArea", payload, index: 0 },
      "*",
    );
    teardown();
  });

  it("calculates insertion index 1 when dropping below a block's midpoint", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div data-pb-area="mainArea">
        <div id="b0" data-pb-block-index="0">Block 0</div>
      </div>
    `;
    const b0 = document.getElementById("b0")!;
    b0.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 10, right: 310, width: 300, height: 100, x: 10, y: 100 } as DOMRect);

    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc1", blockType: "CardBlock" };
    const dt = { types: ["application/x-paperboy"], dropEffect: "", getData: () => JSON.stringify(payload) };

    // Drop at y=180 (below midpoint 150)
    const dropEv = new Event("drop", { bubbles: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt });
    Object.defineProperty(dropEv, "clientY", { value: 180 });
    b0.dispatchEvent(dropEv);

    expect(target.postMessage).toHaveBeenCalledWith(
      { type: "paperboy:drop", field: "mainArea", payload, index: 1 },
      "*",
    );
    teardown();
  });

  it("calculates insertion index between blocks when dropping in a gap", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div data-pb-area="mainArea">
        <div id="b0" data-pb-block-index="0">Block 0</div>
        <div id="b1" data-pb-block-index="1">Block 1</div>
      </div>
    `;
    const b0 = document.getElementById("b0")!;
    const b1 = document.getElementById("b1")!;
    // b0: 100-200 (mid 150), b1: 220-320 (mid 270). Gap is 200-220.
    b0.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 10, right: 310, width: 300, height: 100, x: 10, y: 100 } as DOMRect);
    b1.getBoundingClientRect = () => ({ top: 220, bottom: 320, left: 10, right: 310, width: 300, height: 100, x: 10, y: 220 } as DOMRect);

    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc2", blockType: "CardBlock" };

    // Cross-origin drop-at at y=210 (in gap between b0 and b1)
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => b0;
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:drop-at", x: 50, y: 210, payload }, source: target }));

    expect(target.postMessage).toHaveBeenCalledWith(
      { type: "paperboy:drop", field: "mainArea", payload, index: 1 },
      "*",
    );
    teardown();
  });

  it("appends with omitted index when dropping in an empty content area", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div id="area" data-pb-area="mainArea"></div>`;
    const area = document.getElementById("area")!;
    area.getBoundingClientRect = () => ({ top: 50, bottom: 150, left: 10, right: 310, width: 300, height: 100, x: 10, y: 50 } as DOMRect);

    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc1", blockType: "CardBlock" };
    const dt = { types: ["application/x-paperboy"], dropEffect: "", getData: () => JSON.stringify(payload) };

    const dropEv = new Event("drop", { bubbles: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt });
    Object.defineProperty(dropEv, "clientY", { value: 70 });
    area.dispatchEvent(dropEv);

    expect(target.postMessage).toHaveBeenCalledWith(
      { type: "paperboy:drop", field: "mainArea", payload },
      "*",
    );
    teardown();
  });

  it("isolates nested content areas when computing block indexes (Issue #97 compatibility)", () => {
    const target = makeTarget();
    // mainArea has b0. Inside b0 is columnsArea with its own child nestedB0.
    document.body.innerHTML = `
      <div id="mainArea" data-pb-area="mainArea">
        <div id="b0" data-pb-block-index="0">
          <div id="nestedArea" data-pb-area="columnsArea">
            <div id="nestedB0" data-pb-block-index="0">Nested Block</div>
          </div>
        </div>
      </div>
    `;
    const b0 = document.getElementById("b0")!;
    const nestedB0 = document.getElementById("nestedB0")!;
    b0.getBoundingClientRect = () => ({ top: 100, bottom: 400, left: 10, right: 310, width: 300, height: 300, x: 10, y: 100 } as DOMRect);
    nestedB0.getBoundingClientRect = () => ({ top: 150, bottom: 250, left: 20, right: 290, width: 270, height: 100, x: 20, y: 150 } as DOMRect);

    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc1", blockType: "CardBlock" };

    // Drop on mainArea at y=450 (below b0's midpoint 250).
    // nestedB0 must NOT be treated as a block of mainArea!
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => b0;
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:drop-at", x: 50, y: 450, payload }, source: target }));

    expect(target.postMessage).toHaveBeenCalledWith(
      { type: "paperboy:drop", field: "mainArea", payload, index: 1 },
      "*",
    );
    teardown();
  });

  it("posts paperboy:add-block with the calculated index when hovering over a block", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div id="area" data-pb-area="mainArea">
        <div id="b0" data-pb-block-index="0">Block 0</div>
        <div id="b1" data-pb-block-index="1">Block 1</div>
      </div>
    `;
    const area = document.getElementById("area")!;
    const b0 = document.getElementById("b0")!;
    const b1 = document.getElementById("b1")!;
    area.getBoundingClientRect = () => ({ top: 100, bottom: 350, left: 10, right: 310, width: 300, height: 250, x: 10, y: 100 } as DOMRect);
    b0.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 10, right: 310, width: 300, height: 100, x: 10, y: 100 } as DOMRect);
    b1.getBoundingClientRect = () => ({ top: 220, bottom: 320, left: 10, right: 310, width: 300, height: 100, x: 10, y: 220 } as DOMRect);

    const teardown = initPreviewBridge({ target, badge: false });

    // Hover over b0 in its lower half (y=180, midpoint 150) -> index 1
    const ptrEv = new PointerEvent("pointerover", { bubbles: true });
    Object.defineProperty(ptrEv, "clientY", { value: 180 });
    b0.dispatchEvent(ptrEv);

    target.postMessage.mockClear();
    const addChip = document.querySelector<HTMLElement>(".pb-area-add")!;
    addChip.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(target.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "paperboy:add-block", field: "mainArea", index: 1 }),
      "*",
    );
    teardown();
  });

  it("posts paperboy:add-block with index 0 and anchors at top when hovering above first block", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div id="area" data-pb-area="mainArea">
        <div id="b0" data-pb-block-index="0">Block 0</div>
        <div id="b1" data-pb-block-index="1">Block 1</div>
      </div>
    `;
    const area = document.getElementById("area")!;
    const b0 = document.getElementById("b0")!;
    const b1 = document.getElementById("b1")!;
    area.getBoundingClientRect = () => ({ top: 100, bottom: 350, left: 10, right: 310, width: 300, height: 250, x: 10, y: 100 } as DOMRect);
    b0.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 10, right: 310, width: 300, height: 100, x: 10, y: 100 } as DOMRect);
    b1.getBoundingClientRect = () => ({ top: 220, bottom: 320, left: 10, right: 310, width: 300, height: 100, x: 10, y: 220 } as DOMRect);

    const teardown = initPreviewBridge({ target, badge: false });

    // Hover over b0 in its upper half (y=120, midpoint 150) -> index 0
    const ptrEv = new PointerEvent("pointerover", { bubbles: true });
    Object.defineProperty(ptrEv, "clientY", { value: 120 });
    b0.dispatchEvent(ptrEv);

    target.postMessage.mockClear();
    const addChip = document.querySelector<HTMLElement>(".pb-area-add")!;
    addChip.getBoundingClientRect = () => ({ top: 88, bottom: 112, left: 110, right: 210, width: 100, height: 24, x: 110, y: 88 } as DOMRect);
    addChip.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(target.postMessage).toHaveBeenCalledWith(
      {
        type: "paperboy:add-block",
        field: "mainArea",
        rect: { x: 10, y: 100, w: 300, h: 0 },
        index: 0,
      },
      "*",
    );
    teardown();
  });

  it("posts paperboy:add-block with index 2 and anchors at bottom when hovering below last block", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div id="area" data-pb-area="mainArea">
        <div id="b0" data-pb-block-index="0">Block 0</div>
        <div id="b1" data-pb-block-index="1">Block 1</div>
      </div>
    `;
    const area = document.getElementById("area")!;
    const b0 = document.getElementById("b0")!;
    const b1 = document.getElementById("b1")!;
    area.getBoundingClientRect = () => ({ top: 100, bottom: 350, left: 10, right: 310, width: 300, height: 250, x: 10, y: 100 } as DOMRect);
    b0.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 10, right: 310, width: 300, height: 100, x: 10, y: 100 } as DOMRect);
    b1.getBoundingClientRect = () => ({ top: 220, bottom: 320, left: 10, right: 310, width: 300, height: 100, x: 10, y: 220 } as DOMRect);

    const teardown = initPreviewBridge({ target, badge: false });

    // Hover over b1 in its lower half (y=300, midpoint 270) -> index 2
    const ptrEv = new PointerEvent("pointerover", { bubbles: true });
    Object.defineProperty(ptrEv, "clientY", { value: 300 });
    b1.dispatchEvent(ptrEv);

    target.postMessage.mockClear();
    const addChip = document.querySelector<HTMLElement>(".pb-area-add")!;
    addChip.getBoundingClientRect = () => ({ top: 308, bottom: 332, left: 110, right: 210, width: 100, height: 24, x: 110, y: 308 } as DOMRect);
    addChip.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(target.postMessage).toHaveBeenCalledWith(
      {
        type: "paperboy:add-block",
        field: "mainArea",
        rect: { x: 10, y: 100, w: 300, h: 220 },
        index: 2,
      },
      "*",
    );
    teardown();
  });

  it("manages drop indicator visibility and cleanup during drag lifecycle", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div id="area" data-pb-area="mainArea">
        <div id="b0" data-pb-block-index="0">Block 0</div>
      </div>
    `;
    const b0 = document.getElementById("b0")!;
    b0.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 10, right: 310, width: 300, height: 100, x: 10, y: 100 } as DOMRect);

    const teardown = initPreviewBridge({ target, badge: false });
    const indicator = document.querySelector<HTMLElement>(".pb-drop-indicator")!;
    expect(indicator).not.toBeNull();
    expect(indicator.style.display).toBe("none");

    const payload = { kind: "block", documentId: "doc1", blockType: "CardBlock" };
    const dt = { types: ["application/x-paperboy"], dropEffect: "", getData: () => JSON.stringify(payload) };

    // 1. Dragover above midpoint -> indicator shown at top
    const overEv = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(overEv, "dataTransfer", { value: dt });
    Object.defineProperty(overEv, "clientY", { value: 120 });
    b0.dispatchEvent(overEv);

    expect(indicator.style.display).toBe("");
    expect(indicator.style.left).toBe("10px");
    expect(indicator.style.top).toBe("99px"); // y - 1
    expect(indicator.style.width).toBe("300px");

    // 2. Dragover below midpoint -> indicator moved to bottom
    const overEv2 = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(overEv2, "dataTransfer", { value: dt });
    Object.defineProperty(overEv2, "clientY", { value: 180 });
    b0.dispatchEvent(overEv2);

    expect(indicator.style.display).toBe("");
    expect(indicator.style.top).toBe("199px");

    // 3. Dragleave outside area -> indicator hidden
    const leaveEv = new Event("dragleave", { bubbles: true });
    Object.defineProperty(leaveEv, "relatedTarget", { value: document.body });
    b0.dispatchEvent(leaveEv);
    expect(indicator.style.display).toBe("none");

    // 4. Dragover again, then dragend -> indicator hidden
    b0.dispatchEvent(overEv);
    expect(indicator.style.display).toBe("");
    window.dispatchEvent(new Event("dragend"));
    expect(indicator.style.display).toBe("none");

    // 5. Dragover again, then drop -> indicator hidden
    b0.dispatchEvent(overEv);
    expect(indicator.style.display).toBe("");
    const dropEv = new Event("drop", { bubbles: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt });
    Object.defineProperty(dropEv, "clientY", { value: 120 });
    b0.dispatchEvent(dropEv);
    expect(indicator.style.display).toBe("none");

    // 6. Teardown removes indicator from DOM
    teardown();
    expect(document.querySelector(".pb-drop-indicator")).toBeNull();
  });

  it("handles malformed or missing data-pb-block-index attributes by falling back to DOM index", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div data-pb-area="mainArea">
        <div id="b0" data-pb-block-index="invalid">Block 0</div>
        <div id="b1" data-pb-block-index="-3">Block 1</div>
      </div>
    `;
    const b0 = document.getElementById("b0")!;
    const b1 = document.getElementById("b1")!;
    b0.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 10, right: 310, width: 300, height: 100, x: 10, y: 100 } as DOMRect);
    b1.getBoundingClientRect = () => ({ top: 220, bottom: 320, left: 10, right: 310, width: 300, height: 100, x: 10, y: 220 } as DOMRect);

    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc1", blockType: "CardBlock" };
    const dt = { types: ["application/x-paperboy"], dropEffect: "", getData: () => JSON.stringify(payload) };

    // Dropping above b0 (DOM index 0) -> baseIndex should be DOM index 0, index 0
    const dropEv0 = new Event("drop", { bubbles: true });
    Object.defineProperty(dropEv0, "dataTransfer", { value: dt });
    Object.defineProperty(dropEv0, "clientY", { value: 120 });
    b0.dispatchEvent(dropEv0);

    expect(target.postMessage).toHaveBeenCalledWith(
      { type: "paperboy:drop", field: "mainArea", payload, index: 0 },
      "*",
    );

    target.postMessage.mockClear();
    // Dropping below b1 (DOM index 1) -> baseIndex should be DOM index 1, index 2
    const dropEv1 = new Event("drop", { bubbles: true });
    Object.defineProperty(dropEv1, "dataTransfer", { value: dt });
    Object.defineProperty(dropEv1, "clientY", { value: 300 });
    b1.dispatchEvent(dropEv1);

    expect(target.postMessage).toHaveBeenCalledWith(
      { type: "paperboy:drop", field: "mainArea", payload, index: 2 },
      "*",
    );
    teardown();
  });

  it("warns once when a drop zone's data-pb-area is a boolean-ish marker instead of a field name", () => {
    const target = makeTarget();
    // The classic frontend mistake: data-pb-area="true" — the editor would
    // look up a field literally named "true" and silently ignore the drop.
    document.body.innerHTML = `<div data-pb-area="true"><p id="inner">empty</p></div>`;
    const inner = document.getElementById("inner")!;
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => inner;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc7", blockType: "CardBlock" };
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:drop-at", x: 50, y: 60, payload }, source: target }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:drop-at", x: 50, y: 60, payload }, source: target }));
    const areaWarnings = warn.mock.calls.filter((c) => String(c[0]).includes("FIELD NAME"));
    expect(areaWarnings).toHaveLength(1); // once per bad value, not per drop
    expect(String(areaWarnings[0][0])).toContain('data-pb-area="true"');
    // The drop still posts (the admin surfaces its own error toast for unknown fields).
    expect(target.postMessage).toHaveBeenCalledWith({ type: "paperboy:drop", field: "true", payload }, "*");
    warn.mockRestore();
    teardown();
  });

  it("does NOT warn for a proper field-name area value", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-area="mainArea"><p id="inner">empty</p></div>`;
    const inner = document.getElementById("inner")!;
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => inner;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const teardown = initPreviewBridge({ target, badge: false });
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:drop-at", x: 1, y: 1, payload: { kind: "block", documentId: "d", blockType: "CardBlock" } }, source: target }));
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("FIELD NAME"))).toHaveLength(0);
    warn.mockRestore();
    teardown();
  });

  it("applies paperboy:patch from the parent (live content swap, no reload)", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-field="body">old</div>`;
    const teardown = initPreviewBridge({ target, badge: false });
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:patch", field: "body", html: "<p>new</p>" }, source: target }));
    expect(document.querySelector("[data-pb-field='body']")!.innerHTML).toBe("<p>new</p>");
    teardown();
  });

  it("ignores unknown messages from the parent", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-field="body">keep</div>`;
    const teardown = initPreviewBridge({ target, badge: false });
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:bogus", field: "body", html: "x" }, source: target }));
    expect(document.querySelector("[data-pb-field='body']")!.innerHTML).toBe("keep");
    teardown();
  });
});

/**
 * Sender trust. `paperboy:patch` ends in `el.innerHTML = msg.html`, so the message
 * handler is an HTML injection sink — and it used to accept a message from ANY
 * window, because nothing checked who sent it. `frame-ancestors` does not help:
 * a page that calls `window.open(previewUrl)` holds a window handle and can
 * postMessage into it without ever framing it.
 *
 * The bridge ships to arbitrary external frontends as @paperboycms/preview, so
 * consumers cannot patch this themselves.
 */
describe("initPreviewBridge — only the embedding parent may drive the bridge", () => {
  it("ignores a paperboy:patch from a window that is not the target", () => {
    const target = makeTarget();
    const attacker = makeTarget(); // e.g. a page that did window.open(previewUrl)
    document.body.innerHTML = `<div data-pb-field="body">safe</div>`;
    const teardown = initPreviewBridge({ target, badge: false });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "paperboy:patch", field: "body", html: "<img src=x onerror=alert(1)>" },
        source: attacker,
      }),
    );
    expect(document.querySelector("[data-pb-field='body']")!.innerHTML).toBe("safe");
    teardown();
  });

  it("ignores a message with NO source (can't be attributed to the parent)", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-field="body">safe</div>`;
    const teardown = initPreviewBridge({ target, badge: false });
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "paperboy:patch", field: "body", html: "<p>x</p>" } }),
    );
    expect(document.querySelector("[data-pb-field='body']")!.innerHTML).toBe("safe");
    teardown();
  });

  it("ignores a drop-at from a foreign window (no forged block insertion)", () => {
    const target = makeTarget();
    const attacker = makeTarget();
    document.body.innerHTML = `<div data-pb-area="mainArea"><p id="inner">x</p></div>`;
    const inner = document.getElementById("inner")!;
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => inner;
    const teardown = initPreviewBridge({ target, badge: false });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "paperboy:drop-at", x: 1, y: 1, payload: { kind: "block", documentId: "d", blockType: "CardBlock" } },
        source: attacker,
      }),
    );
    // The bridge answers a real drop-at by posting paperboy:drop back to the
    // parent; a foreign sender must produce no message at all.
    expect(target.postMessage.mock.calls.filter((c) => c[0]?.type === "paperboy:drop")).toHaveLength(0);
    teardown();
  });

  // parentOrigin is ADDITIVE (optional) so already-deployed frontends keep working.
  it("when parentOrigin is set, a matching origin is accepted", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-field="body">old</div>`;
    const teardown = initPreviewBridge({ target, badge: false, parentOrigin: "https://admin.example" });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "paperboy:patch", field: "body", html: "<p>new</p>" },
        source: target,
        origin: "https://admin.example",
      }),
    );
    expect(document.querySelector("[data-pb-field='body']")!.innerHTML).toBe("<p>new</p>");
    teardown();
  });

  it("when parentOrigin is set, a mismatching origin is rejected", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-field="body">safe</div>`;
    const teardown = initPreviewBridge({ target, badge: false, parentOrigin: "https://admin.example" });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "paperboy:patch", field: "body", html: "<p>evil</p>" },
        source: target,
        origin: "https://evil.example",
      }),
    );
    expect(document.querySelector("[data-pb-field='body']")!.innerHTML).toBe("safe");
    teardown();
  });

  it("when parentOrigin is set, outbound posts target it instead of '*'", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-field="body">x</div>`;
    const teardown = initPreviewBridge({ target, badge: false, parentOrigin: "https://admin.example" });
    // preview-ready is posted during init.
    const ready = target.postMessage.mock.calls.find((c) => c[0]?.type === "paperboy:preview-ready");
    expect(ready?.[1]).toBe("https://admin.example");
    teardown();
  });

  it("without parentOrigin, outbound posts stay '*' (back-compat)", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-field="body">x</div>`;
    const teardown = initPreviewBridge({ target, badge: false });
    const ready = target.postMessage.mock.calls.find((c) => c[0]?.type === "paperboy:preview-ready");
    expect(ready?.[1]).toBe("*");
    teardown();
  });

  it("the badge never conflicts with the content beneath it: click-transparent and self-dismissing", () => {
    // The badge is fixed top-center over the page, so it inevitably sits on top
    // of SOME editable content. It must therefore (a) never intercept a click
    // meant for the element under it and (b) get out of the way on its own —
    // edit mode stays visible through the outlines on every editable element.
    const target = makeTarget();
    const teardown = initPreviewBridge({ target });
    expect(document.querySelector(".pb-edit-badge")).not.toBeNull();
    const css = document.querySelector("style[data-pb-bridge]")!.textContent!;
    const badgeRule = /\.pb-edit-badge\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(badgeRule).toContain("pointer-events:none");
    expect(badgeRule).toMatch(/animation:pb-badge-out/);
    // The fade must END invisible to hit-testing too, not just transparent.
    expect(css).toMatch(/@keyframes pb-badge-out\{to\{opacity:0;visibility:hidden\}\}/);
    teardown();
    expect(document.querySelector(".pb-edit-badge")).toBeNull();
  });
});

describe("initPreviewBridge — scroll tracking for anchored overlays", () => {
  it("emits paperboy:rect with updated coordinates when scrolling occurs while an anchored overlay is open (add chip)", async () => {
    const target = makeTarget();
    document.body.innerHTML = `<div id="area" data-pb-area="mainArea"><p id="inner">block</p></div>`;
    const area = document.getElementById("area")!;
    let currentRect = { x: 20, y: 100, width: 600, height: 300, top: 100, left: 20, right: 620, bottom: 400 };
    area.getBoundingClientRect = () => currentRect as DOMRect;

    const teardown = initPreviewBridge({ target, badge: false });
    document.getElementById("inner")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    const add = document.querySelector<HTMLElement>(".pb-area-add")!;
    expect(add.style.display).not.toBe("none");

    target.postMessage.mockClear();
    add.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(target.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "paperboy:add-block", field: "mainArea" }),
      "*",
    );
    target.postMessage.mockClear();

    // Element moves due to scroll
    currentRect = { x: 20, y: 40, width: 600, height: 300, top: 40, left: 20, right: 620, bottom: 340 };
    window.dispatchEvent(new Event("scroll"));

    await new Promise((r) => window.requestAnimationFrame(r));

    expect(target.postMessage).toHaveBeenCalledWith(
      {
        type: "paperboy:rect",
        field: "mainArea",
        blockIndex: null,
        rect: { x: 20, y: 40, w: 600, h: 300 },
      },
      "*",
    );
    teardown();
  });

  it("does not emit extra paperboy:rect updates when scrolling occurs with no anchored overlay open", async () => {
    const target = makeTarget();
    document.body.innerHTML = `<div id="area" data-pb-area="mainArea"><p id="inner">block</p></div>`;
    const teardown = initPreviewBridge({ target, badge: false });

    // Hover area so hoveredArea is set, but no click was performed (no overlay opened)
    document.getElementById("inner")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    target.postMessage.mockClear();

    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));

    await new Promise((r) => window.requestAnimationFrame(r));

    const rectCalls = target.postMessage.mock.calls.filter((c) => c[0]?.type === "paperboy:rect");
    expect(rectCalls).toHaveLength(0);
    teardown();
  });

  it("throttles repeated scroll events using requestAnimationFrame", async () => {
    const target = makeTarget();
    document.body.innerHTML = `<div id="area" data-pb-area="mainArea"><p id="inner">block</p></div>`;
    const area = document.getElementById("area")!;
    let currentRect = { x: 20, y: 100, width: 600, height: 300, top: 100, left: 20, right: 620, bottom: 400 };
    area.getBoundingClientRect = () => currentRect as DOMRect;

    const teardown = initPreviewBridge({ target, badge: false });
    document.getElementById("inner")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    document.querySelector<HTMLElement>(".pb-area-add")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    target.postMessage.mockClear();

    // Rapid successive scroll events
    currentRect = { x: 20, y: 90, width: 600, height: 300, top: 90, left: 20, right: 620, bottom: 390 };
    window.dispatchEvent(new Event("scroll"));
    currentRect = { x: 20, y: 80, width: 600, height: 300, top: 80, left: 20, right: 620, bottom: 380 };
    window.dispatchEvent(new Event("scroll"));
    currentRect = { x: 20, y: 70, width: 600, height: 300, top: 70, left: 20, right: 620, bottom: 370 };
    window.dispatchEvent(new Event("scroll"));

    await new Promise((r) => window.requestAnimationFrame(r));

    const rectCalls = target.postMessage.mock.calls.filter((c) => c[0]?.type === "paperboy:rect");
    expect(rectCalls).toHaveLength(1);
    expect(rectCalls[0][0].rect.y).toBe(70);
    teardown();
  });

  it("stops sending updates when the anchored element is disconnected from the DOM", async () => {
    const target = makeTarget();
    document.body.innerHTML = `<div id="area" data-pb-area="mainArea"><p id="inner">block</p></div>`;
    const area = document.getElementById("area")!;
    const teardown = initPreviewBridge({ target, badge: false });

    document.getElementById("inner")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    document.querySelector<HTMLElement>(".pb-area-add")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    target.postMessage.mockClear();

    // Remove anchored element
    area.remove();

    window.dispatchEvent(new Event("scroll"));
    await new Promise((r) => window.requestAnimationFrame(r));

    const rectCalls = target.postMessage.mock.calls.filter((c) => c[0]?.type === "paperboy:rect");
    expect(rectCalls).toHaveLength(0);
    teardown();
  });

  it("cancels pending animation frames on teardown and ignores further scroll events", async () => {
    const target = makeTarget();
    document.body.innerHTML = `<div id="area" data-pb-area="mainArea"><p id="inner">block</p></div>`;
    const teardown = initPreviewBridge({ target, badge: false });

    document.getElementById("inner")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    document.querySelector<HTMLElement>(".pb-area-add")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    target.postMessage.mockClear();

    // Trigger scroll and immediately tear down
    window.dispatchEvent(new Event("scroll"));
    teardown();

    await new Promise((r) => setTimeout(r, 50));

    const rectCalls = target.postMessage.mock.calls.filter((c) => c[0]?.type === "paperboy:rect");
    expect(rectCalls).toHaveLength(0);

    // Further scroll after teardown emits nothing
    window.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 50));
    expect(target.postMessage.mock.calls.filter((c) => c[0]?.type === "paperboy:rect")).toHaveLength(0);
  });

  it("stops sending updates after the Add-block palette closes", async () => {
    const target = makeTarget();
    document.body.innerHTML = `<div id="area" data-pb-area="mainArea"><p id="inner">block</p></div>`;
    const area = document.getElementById("area")!;
    let currentRect = { x: 20, y: 100, width: 600, height: 300, top: 100, left: 20, right: 620, bottom: 400 };
    area.getBoundingClientRect = () => currentRect as DOMRect;

    const teardown = initPreviewBridge({ target, badge: false });
    document.getElementById("inner")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    const add = document.querySelector<HTMLElement>(".pb-area-add")!;
    add.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(target.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "paperboy:add-block", field: "mainArea" }),
      "*",
    );
    target.postMessage.mockClear();

    // Scroll while palette is open emits update
    currentRect = { x: 20, y: 80, width: 600, height: 300, top: 80, left: 20, right: 620, bottom: 380 };
    window.dispatchEvent(new Event("scroll"));
    await new Promise((r) => window.requestAnimationFrame(r));
    expect(target.postMessage).toHaveBeenCalledWith(
      {
        type: "paperboy:rect",
        field: "mainArea",
        blockIndex: null,
        rect: { x: 20, y: 80, w: 600, h: 300 },
      },
      "*",
    );
    target.postMessage.mockClear();

    // Closing the overlay in the admin sends paperboy:rect with rect: null
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "paperboy:rect", field: "mainArea", blockIndex: null, rect: null },
        source: target,
      }),
    );

    // Preview scrolls after palette was closed
    currentRect = { x: 20, y: 50, width: 600, height: 300, top: 50, left: 20, right: 620, bottom: 350 };
    window.dispatchEvent(new Event("scroll"));
    await new Promise((r) => window.requestAnimationFrame(r));

    const rectCalls = target.postMessage.mock.calls.filter((c) => c[0]?.type === "paperboy:rect");
    expect(rectCalls).toHaveLength(0);
    teardown();
  });

  it("does not clear tracking when paperboy:rect carries a non-null rectangle or targets a different field", async () => {
    const target = makeTarget();
    document.body.innerHTML = `<div id="area" data-pb-area="mainArea"><p id="inner">block</p></div>`;
    const area = document.getElementById("area")!;
    let currentRect = { x: 20, y: 100, width: 600, height: 300, top: 100, left: 20, right: 620, bottom: 400 };
    area.getBoundingClientRect = () => currentRect as DOMRect;

    const teardown = initPreviewBridge({ target, badge: false });
    document.getElementById("inner")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    const add = document.querySelector<HTMLElement>(".pb-area-add")!;
    add.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    target.postMessage.mockClear();

    // Inbound paperboy:rect with a non-null rectangle retains tracking
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "paperboy:rect", field: "mainArea", blockIndex: null, rect: { x: 20, y: 100, w: 600, h: 300 } },
        source: target,
      }),
    );

    // Inbound paperboy:rect with rect: null for a DIFFERENT field does not clear tracking
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "paperboy:rect", field: "differentArea", blockIndex: null, rect: null },
        source: target,
      }),
    );

    // Scrolling still emits rect updates for mainArea
    currentRect = { x: 20, y: 80, width: 600, height: 300, top: 80, left: 20, right: 620, bottom: 380 };
    window.dispatchEvent(new Event("scroll"));
    await new Promise((r) => window.requestAnimationFrame(r));

    const rectCalls = target.postMessage.mock.calls.filter((c) => c[0]?.type === "paperboy:rect");
    expect(rectCalls).toHaveLength(1);
    expect(rectCalls[0][0].field).toBe("mainArea");
    expect(rectCalls[0][0].rect.y).toBe(80);
    target.postMessage.mockClear();

    // Now send rect: null for mainArea -> stops tracking
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "paperboy:rect", field: "mainArea", blockIndex: null, rect: null },
        source: target,
      }),
    );

    window.dispatchEvent(new Event("scroll"));
    await new Promise((r) => window.requestAnimationFrame(r));
    expect(target.postMessage.mock.calls.filter((c) => c[0]?.type === "paperboy:rect")).toHaveLength(0);

    teardown();
  });

  it("stops tracking when paperboy:rect matches both field and block index, but ignores signals for a different block", async () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div data-pb-block-index="0" data-pb-block-type="hero">
        <h1 id="heading0" data-pb-field="title">Hero 0</h1>
      </div>
      <div data-pb-block-index="1" data-pb-block-type="hero">
        <h1 id="heading1" data-pb-field="title">Hero 1</h1>
      </div>
    `;
    const heading1 = document.getElementById("heading1")!;
    let currentRect = { x: 10, y: 50, width: 200, height: 30, top: 50, left: 10, right: 210, bottom: 80 };
    heading1.getBoundingClientRect = () => currentRect as DOMRect;

    const teardown = initPreviewBridge({ target, badge: false });
    heading1.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(target.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "paperboy:edit", field: "title", blockIndex: 1 }),
      "*",
    );
    target.postMessage.mockClear();

    // Inbound close signal (rect: null) for block 0 with same field "title" does NOT stop tracking block 1
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "paperboy:rect", field: "title", blockIndex: 0, rect: null },
        source: target,
      }),
    );

    // Scroll still emits rect for block 1
    currentRect = { x: 10, y: 30, width: 200, height: 30, top: 30, left: 10, right: 210, bottom: 60 };
    window.dispatchEvent(new Event("scroll"));
    await new Promise((r) => window.requestAnimationFrame(r));

    const rectCalls = target.postMessage.mock.calls.filter((c) => c[0]?.type === "paperboy:rect");
    expect(rectCalls).toHaveLength(1);
    expect(rectCalls[0][0]).toEqual({
      type: "paperboy:rect",
      field: "title",
      blockIndex: 1,
      rect: { x: 10, y: 30, w: 200, h: 30 },
    });
    target.postMessage.mockClear();

    // Now send close signal matching block 1 -> stops tracking
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "paperboy:rect", field: "title", blockIndex: 1, rect: null },
        source: target,
      }),
    );

    window.dispatchEvent(new Event("scroll"));
    await new Promise((r) => window.requestAnimationFrame(r));
    expect(target.postMessage.mock.calls.filter((c) => c[0]?.type === "paperboy:rect")).toHaveLength(0);

    teardown();
  });

  it("emits paperboy:rect with updated coordinates when scrolling occurs while an editable field overlay is open", async () => {
    const target = makeTarget();
    document.body.innerHTML = `<div id="field" data-pb-field="heading">Hello</div>`;
    const field = document.getElementById("field")!;
    let currentRect = { x: 10, y: 50, width: 200, height: 30, top: 50, left: 10, right: 210, bottom: 80 };
    field.getBoundingClientRect = () => currentRect as DOMRect;

    const teardown = initPreviewBridge({ target, badge: false });
    field.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(target.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "paperboy:edit", field: "heading" }),
      "*",
    );
    target.postMessage.mockClear();

    // Field moves due to scroll
    currentRect = { x: 10, y: 15, width: 200, height: 30, top: 15, left: 10, right: 210, bottom: 45 };
    window.dispatchEvent(new Event("scroll"));

    await new Promise((r) => window.requestAnimationFrame(r));

    expect(target.postMessage).toHaveBeenCalledWith(
      {
        type: "paperboy:rect",
        field: "heading",
        blockIndex: null,
        rect: { x: 10, y: 15, w: 200, h: 30 },
      },
      "*",
    );
    teardown();
  });
});

describe("initPreviewBridge — targeted second review edge cases", () => {
  it("calculates index from final drop coordinates rather than stale dragover index within the same area (same-origin)", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div data-pb-area="mainArea">
        <div id="b0" data-pb-block-index="0">Block 0</div>
      </div>
    `;
    const b0 = document.getElementById("b0")!;
    // b0 bounds: top 100, bottom 200, midpoint 150
    b0.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 10, right: 310, width: 300, height: 100, x: 10, y: 100 } as DOMRect);

    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc1", blockType: "CardBlock" };
    const dt = { types: ["application/x-paperboy"], dropEffect: "", getData: () => JSON.stringify(payload) };

    // 1. Dragover at y=120 (above midpoint 150 -> index 0)
    const overEv = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(overEv, "dataTransfer", { value: dt });
    Object.defineProperty(overEv, "clientY", { value: 120 });
    b0.dispatchEvent(overEv);

    // 2. Drop at y=180 (below midpoint 150 -> should calculate index 1 from final pointer coords)
    const dropEv = new Event("drop", { bubbles: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt });
    Object.defineProperty(dropEv, "clientY", { value: 180 });
    b0.dispatchEvent(dropEv);

    expect(target.postMessage).toHaveBeenCalledWith(
      { type: "paperboy:drop", field: "mainArea", payload, index: 1 },
      "*",
    );
    teardown();
  });

  it("calculates index from final drop coordinates when moving between different content areas without intervening dragover (same-origin)", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div id="area1" data-pb-area="area1">
        <div id="a1_b0" data-pb-block-index="0">Area 1 Block 0</div>
      </div>
      <div id="area2" data-pb-area="area2">
        <div id="a2_b0" data-pb-block-index="0">Area 2 Block 0</div>
        <div id="a2_b1" data-pb-block-index="1">Area 2 Block 1</div>
      </div>
    `;
    const a1_b0 = document.getElementById("a1_b0")!;
    const a2_b0 = document.getElementById("a2_b0")!;
    const a2_b1 = document.getElementById("a2_b1")!;

    a1_b0.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 10, right: 310, width: 300, height: 100, x: 10, y: 100 } as DOMRect);
    a2_b0.getBoundingClientRect = () => ({ top: 300, bottom: 400, left: 10, right: 310, width: 300, height: 100, x: 10, y: 300 } as DOMRect);
    a2_b1.getBoundingClientRect = () => ({ top: 420, bottom: 520, left: 10, right: 310, width: 300, height: 100, x: 10, y: 420 } as DOMRect);

    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc2", blockType: "CardBlock" };
    const dt = { types: ["application/x-paperboy"], dropEffect: "", getData: () => JSON.stringify(payload) };

    // Dragover on area1 at y=120 (calculates index 0 for area1)
    const overEv = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(overEv, "dataTransfer", { value: dt });
    Object.defineProperty(overEv, "clientY", { value: 120 });
    a1_b0.dispatchEvent(overEv);

    // Drop immediately on area2 at y=480 (in lower half of a2_b1, midpoint 470 -> index 2)
    const dropEv = new Event("drop", { bubbles: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt });
    Object.defineProperty(dropEv, "clientY", { value: 480 });
    a2_b1.dispatchEvent(dropEv);

    expect(target.postMessage).toHaveBeenCalledWith(
      { type: "paperboy:drop", field: "area2", payload, index: 2 },
      "*",
    );
    teardown();
  });

  it("calculates index from final drop coordinates in drop-at rather than stale drag-at index (cross-origin)", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div data-pb-area="mainArea">
        <div id="b0" data-pb-block-index="0">Block 0</div>
      </div>
    `;
    const b0 = document.getElementById("b0")!;
    b0.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 10, right: 310, width: 300, height: 100, x: 10, y: 100 } as DOMRect);
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => b0;

    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc3", blockType: "CardBlock" };

    // 1. drag-at sent at y=120 (above midpoint 150 -> index 0)
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:drag-at", x: 50, y: 120 }, source: target }));

    // 2. drop-at sent at y=180 (below midpoint 150 -> index 1)
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:drop-at", x: 50, y: 180, payload }, source: target }));

    expect(target.postMessage).toHaveBeenCalledWith(
      { type: "paperboy:drop", field: "mainArea", payload, index: 1 },
      "*",
    );
    teardown();
  });

  it("calculates index from final drop-at coordinates when drop-at lands on a different zone than drag-at (cross-origin)", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div id="area1" data-pb-area="area1">
        <div id="a1_b0" data-pb-block-index="0">Area 1 Block 0</div>
      </div>
      <div id="area2" data-pb-area="area2">
        <div id="a2_b0" data-pb-block-index="0">Area 2 Block 0</div>
      </div>
    `;
    const a1_b0 = document.getElementById("a1_b0")!;
    const a2_b0 = document.getElementById("a2_b0")!;

    a1_b0.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 10, right: 310, width: 300, height: 100, x: 10, y: 100 } as DOMRect);
    a2_b0.getBoundingClientRect = () => ({ top: 300, bottom: 400, left: 10, right: 310, width: 300, height: 100, x: 10, y: 300 } as DOMRect);

    let currentHit: Element = a1_b0;
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => currentHit;

    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc4", blockType: "CardBlock" };

    // drag-at over area 1
    currentHit = a1_b0;
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:drag-at", x: 50, y: 120 }, source: target }));

    // drop-at over area 2 below midpoint (y=380, mid 350 -> index 1)
    currentHit = a2_b0;
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:drop-at", x: 50, y: 380, payload }, source: target }));

    expect(target.postMessage).toHaveBeenCalledWith(
      { type: "paperboy:drop", field: "area2", payload, index: 1 },
      "*",
    );
    teardown();
  });

  it("positions add-block chip at bottom-center of empty content area and posts add-block with omitted index", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div id="emptyArea" data-pb-area="emptyArea"></div>`;
    const emptyArea = document.getElementById("emptyArea")!;
    emptyArea.getBoundingClientRect = () => ({
      top: 100,
      bottom: 160,
      left: 20,
      right: 420,
      width: 400,
      height: 60,
      x: 20,
      y: 100,
    } as DOMRect);

    const teardown = initPreviewBridge({ target, badge: false });
    const ptrEv = new PointerEvent("pointerover", { bubbles: true });
    Object.defineProperty(ptrEv, "clientY", { value: 120 });
    emptyArea.dispatchEvent(ptrEv);

    const addChip = document.querySelector<HTMLElement>(".pb-area-add")!;
    expect(addChip.style.display).not.toBe("none");
    expect(addChip.style.left).toBe("220px"); // 20 + 400/2
    expect(addChip.style.top).toBe("160px"); // 100 + 60

    addChip.getBoundingClientRect = () => ({
      top: 148,
      bottom: 172,
      left: 170,
      right: 270,
      width: 100,
      height: 24,
      x: 170,
      y: 148,
    } as DOMRect);

    target.postMessage.mockClear();
    addChip.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(target.postMessage).toHaveBeenCalledWith(
      {
        type: "paperboy:add-block",
        field: "emptyArea",
        rect: { x: 20, y: 100, w: 400, h: 60 },
      },
      "*",
    );
    teardown();
  });

  it("highlights empty area on dragover without showing line drop indicator and drops with omitted index", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div id="emptyArea" data-pb-area="emptyArea"></div>`;
    const emptyArea = document.getElementById("emptyArea")!;
    emptyArea.getBoundingClientRect = () => ({
      top: 100,
      bottom: 160,
      left: 20,
      right: 420,
      width: 400,
      height: 60,
      x: 20,
      y: 100,
    } as DOMRect);

    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc5", blockType: "CardBlock" };
    const dt = { types: ["application/x-paperboy"], dropEffect: "", getData: () => JSON.stringify(payload) };

    const overEv = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(overEv, "dataTransfer", { value: dt });
    Object.defineProperty(overEv, "clientY", { value: 130 });
    emptyArea.dispatchEvent(overEv);

    expect(emptyArea.classList.contains("pb-drop-active")).toBe(true);
    const indicator = document.querySelector<HTMLElement>(".pb-drop-indicator")!;
    expect(indicator.style.display).toBe("none");

    const dropEv = new Event("drop", { bubbles: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt });
    Object.defineProperty(dropEv, "clientY", { value: 130 });
    emptyArea.dispatchEvent(dropEv);

    expect(target.postMessage).toHaveBeenCalledWith(
      { type: "paperboy:drop", field: "emptyArea", payload },
      "*",
    );
    teardown();
  });

  it("cross-origin drop-at on empty area posts paperboy:drop with omitted index", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div id="emptyArea" data-pb-area="emptyArea"></div>`;
    const emptyArea = document.getElementById("emptyArea")!;
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => emptyArea;

    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc6", blockType: "HeroBlock" };

    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:drop-at", x: 50, y: 120, payload }, source: target }));

    expect(target.postMessage).toHaveBeenCalledWith(
      { type: "paperboy:drop", field: "emptyArea", payload },
      "*",
    );
    teardown();
  });

  it("inner-area drop never uses outer-area insertion index after dragover in outer area", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div id="outerArea" data-pb-area="outerArea">
        <div id="out_b0" data-pb-block-index="0">Outer 0</div>
        <div id="out_b1" data-pb-block-index="1">
          <div id="innerArea" data-pb-area="innerArea">
            <div id="in_b0" data-pb-block-index="0">Inner 0</div>
            <div id="in_b1" data-pb-block-index="1">Inner 1</div>
          </div>
        </div>
      </div>
    `;
    const out_b0 = document.getElementById("out_b0")!;
    const in_b1 = document.getElementById("in_b1")!;

    out_b0.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 10, right: 310, width: 300, height: 100, x: 10, y: 100 } as DOMRect);
    in_b1.getBoundingClientRect = () => ({ top: 320, bottom: 420, left: 20, right: 290, width: 270, height: 100, x: 20, y: 320 } as DOMRect);

    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc7", blockType: "CardBlock" };
    const dt = { types: ["application/x-paperboy"], dropEffect: "", getData: () => JSON.stringify(payload) };

    // Dragover outer area at y=120 (above out_b0 midpoint 150 -> index 0 for outerArea)
    const overEv = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(overEv, "dataTransfer", { value: dt });
    Object.defineProperty(overEv, "clientY", { value: 120 });
    out_b0.dispatchEvent(overEv);

    // Drop on in_b1 in innerArea at y=400 (below in_b1 midpoint 370 -> index 2 for innerArea)
    const dropEv = new Event("drop", { bubbles: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt });
    Object.defineProperty(dropEv, "clientY", { value: 400 });
    in_b1.dispatchEvent(dropEv);

    expect(target.postMessage).toHaveBeenCalledWith(
      {
        type: "paperboy:drop",
        field: "innerArea",
        payload,
        index: 2,
        path: [{ field: "outerArea", blockIndex: 1 }],
      },
      "*",
    );
    teardown();
  });

  it("outer-area drop never uses inner-area insertion index after dragover in inner area", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div id="outerArea" data-pb-area="outerArea">
        <div id="out_b0" data-pb-block-index="0">Outer 0</div>
        <div id="out_b1" data-pb-block-index="1">
          <div id="innerArea" data-pb-area="innerArea">
            <div id="in_b0" data-pb-block-index="0">Inner 0</div>
          </div>
        </div>
      </div>
    `;
    const out_b0 = document.getElementById("out_b0")!;
    const in_b0 = document.getElementById("in_b0")!;

    out_b0.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 10, right: 310, width: 300, height: 100, x: 10, y: 100 } as DOMRect);
    in_b0.getBoundingClientRect = () => ({ top: 220, bottom: 300, left: 20, right: 290, width: 270, height: 80, x: 20, y: 220 } as DOMRect);

    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc8", blockType: "CardBlock" };
    const dt = { types: ["application/x-paperboy"], dropEffect: "", getData: () => JSON.stringify(payload) };

    // Dragover inner area at y=240 (above in_b0 midpoint 260 -> index 0 for innerArea)
    const overEv = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(overEv, "dataTransfer", { value: dt });
    Object.defineProperty(overEv, "clientY", { value: 240 });
    in_b0.dispatchEvent(overEv);

    // Drop on out_b0 in outer area at y=180 (below out_b0 midpoint 150 -> index 1 for outerArea)
    const dropEv = new Event("drop", { bubbles: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt });
    Object.defineProperty(dropEv, "clientY", { value: 180 });
    out_b0.dispatchEvent(dropEv);

    expect(target.postMessage).toHaveBeenCalledWith(
      { type: "paperboy:drop", field: "outerArea", payload, index: 1 },
      "*",
    );
    teardown();
  });

  it("clears dragPayload, dropZone, and indicator on dragend", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div id="area" data-pb-area="mainArea">
        <div id="b0" data-pb-block-index="0">Block 0</div>
      </div>
    `;
    const area = document.getElementById("area")!;
    const b0 = document.getElementById("b0")!;
    b0.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 10, right: 310, width: 300, height: 100, x: 10, y: 100 } as DOMRect);

    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc9", blockType: "HeroBlock" };

    // Cross-origin dragsource sets dragPayload
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:dragsource", payload }, source: target }));

    // Dragover without MIME still activates because dragPayload was set
    const dt = { types: [] as string[], dropEffect: "", getData: () => "" };
    const overEv = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(overEv, "dataTransfer", { value: dt });
    Object.defineProperty(overEv, "clientY", { value: 120 });
    b0.dispatchEvent(overEv);

    expect(area.classList.contains("pb-drop-active")).toBe(true);

    // Window dragend fires
    window.dispatchEvent(new Event("dragend"));
    expect(area.classList.contains("pb-drop-active")).toBe(false);

    // Subsequent dragover without MIME must now be ignored because dragPayload was cleared
    b0.dispatchEvent(overEv);
    expect(area.classList.contains("pb-drop-active")).toBe(false);

    teardown();
  });

  it("clears dropZone when dragleave leaves drop zone to another area", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div id="area1" data-pb-area="area1"><p id="p1">Area 1</p></div>
      <div id="area2" data-pb-area="area2"><p id="p2">Area 2</p></div>
    `;
    const area1 = document.getElementById("area1")!;
    const p1 = document.getElementById("p1")!;
    const p2 = document.getElementById("p2")!;

    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc10", blockType: "CardBlock" };
    const dt = { types: ["application/x-paperboy"], dropEffect: "", getData: () => JSON.stringify(payload) };

    const overEv = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(overEv, "dataTransfer", { value: dt });
    Object.defineProperty(overEv, "clientY", { value: 50 });
    p1.dispatchEvent(overEv);
    expect(area1.classList.contains("pb-drop-active")).toBe(true);

    // Leave area1 with relatedTarget in area2
    const leaveEv = new Event("dragleave", { bubbles: true });
    Object.defineProperty(leaveEv, "relatedTarget", { value: p2 });
    p1.dispatchEvent(leaveEv);

    expect(area1.classList.contains("pb-drop-active")).toBe(false);
    teardown();
  });

  it("clears prior window listeners if re-initialized after style node was removed without teardown", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-field="title">Title</div>`;
    const title = document.querySelector("[data-pb-field]")!;

    initPreviewBridge({ target, badge: false });
    // Simulate head reset without calling teardown on the first instance
    document.querySelector("style[data-pb-bridge]")!.remove();

    // Re-initialize bridge
    const teardown2 = initPreviewBridge({ target, badge: false });
    target.postMessage.mockClear();

    // Click field -> should post paperboy:edit only ONCE, not twice from stacked listeners
    title.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(target.postMessage.mock.calls.filter((c) => c[0]?.type === "paperboy:edit")).toHaveLength(1);

    teardown2();
  });

  it("includes ancestor path when dropping into a two-level nested content area", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div id="mainArea" data-pb-area="mainArea">
        <div id="b0" data-pb-block-index="0">
          <div id="columnsArea" data-pb-area="columnsArea">
            <div id="b1" data-pb-block-index="1">
              <div id="innerArea" data-pb-area="innerArea">
                <p id="pInner">Nested drop zone</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc1", blockType: "CardBlock" };

    const innerZone = document.getElementById("innerArea")!;
    const dropEv = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv, "dataTransfer", {
      value: {
        types: [DRAG_MIME],
        getData: (mime: string) => (mime === DRAG_MIME ? JSON.stringify(payload) : ""),
      },
    });
    innerZone.dispatchEvent(dropEv);

    expect(target.postMessage).toHaveBeenCalledWith(
      {
        type: "paperboy:drop",
        field: "innerArea",
        payload,
        path: [
          { field: "mainArea", blockIndex: 0 },
          { field: "columnsArea", blockIndex: 1 },
        ],
      },
      "*",
    );
    teardown();
  });

  it("includes ancestor path on cross-origin drop-at into a nested content area", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div id="mainArea" data-pb-area="mainArea">
        <div id="b0" data-pb-block-index="0">
          <div id="columnsArea" data-pb-area="columnsArea">
            <div id="b1" data-pb-block-index="1">
              <div id="innerArea" data-pb-area="innerArea">
                <p id="pInner">Nested drop zone</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    const teardown = initPreviewBridge({ target, badge: false });
    const payload = { kind: "block", documentId: "doc1", blockType: "CardBlock" };

    const innerZone = document.getElementById("innerArea")!;
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => innerZone;

    target.postMessage.mockClear();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:drop-at", x: 50, y: 50, payload }, source: target }));

    expect(target.postMessage).toHaveBeenCalledWith(
      {
        type: "paperboy:drop",
        field: "innerArea",
        payload,
        path: [
          { field: "mainArea", blockIndex: 0 },
          { field: "columnsArea", blockIndex: 1 },
        ],
      },
      "*",
    );
    teardown();
  });

  it("includes ancestor path when clicking add-block chip on a nested content area", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div id="mainArea" data-pb-area="mainArea">
        <div id="b0" data-pb-block-index="0">
          <div id="columnsArea" data-pb-area="columnsArea">
            <p id="pInner">Nested area</p>
          </div>
        </div>
      </div>
    `;
    const teardown = initPreviewBridge({ target, badge: false });
    const pInner = document.getElementById("pInner")!;

    pInner.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    const chip = document.querySelector(".pb-area-add") as HTMLButtonElement | null;
    expect(chip).toBeTruthy();

    target.postMessage.mockClear();
    chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(target.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "paperboy:add-block",
        field: "columnsArea",
        path: [{ field: "mainArea", blockIndex: 0 }],
      }),
      "*",
    );
    teardown();
  });

  it("includes ancestor path when clicking to edit a field inside a nested block", () => {
    const target = makeTarget();
    document.body.innerHTML = `
      <div id="mainArea" data-pb-area="mainArea">
        <div id="b0" data-pb-block-index="0">
          <div id="columnsArea" data-pb-area="columnsArea">
            <div id="b1" data-pb-block-index="1">
              <p id="nestedTitle" data-pb-field="title">Nested Title</p>
            </div>
          </div>
        </div>
      </div>
    `;
    const teardown = initPreviewBridge({ target, badge: false });
    const nestedTitle = document.getElementById("nestedTitle")!;

    target.postMessage.mockClear();
    nestedTitle.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(target.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "paperboy:edit",
        field: "title",
        blockIndex: 1,
        path: [
          { field: "mainArea", blockIndex: 0 },
          { field: "columnsArea", blockIndex: 1 },
        ],
      }),
      "*",
    );
    teardown();
  });
});
