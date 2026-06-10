// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initPreviewBridge } from "./bridge.js";

const makeTarget = () => ({ postMessage: vi.fn() }) as unknown as Window;

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

  it("posts paperboy:edit when an editable region is clicked", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-field="heading">Hi</div>`;
    const teardown = initPreviewBridge({ target, badge: false });
    (target.postMessage as ReturnType<typeof vi.fn>).mockClear();
    document.querySelector("[data-pb-field]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(target.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "paperboy:edit", field: "heading" }), "*");
    teardown();
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
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:dragsource", payload } }));
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
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:drop-at", x: 50, y: 60, payload } }));
    expect(target.postMessage).toHaveBeenCalledWith({ type: "paperboy:drop", field: "contentarea", payload }, "*");
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
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:drop-at", x: 50, y: 60, payload } }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:drop-at", x: 50, y: 60, payload } }));
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
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:drop-at", x: 1, y: 1, payload: { kind: "block", documentId: "d", blockType: "CardBlock" } } }));
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("FIELD NAME"))).toHaveLength(0);
    warn.mockRestore();
    teardown();
  });

  it("applies paperboy:patch from the parent (live content swap, no reload)", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-field="body">old</div>`;
    const teardown = initPreviewBridge({ target, badge: false });
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:patch", field: "body", html: "<p>new</p>" } }));
    expect(document.querySelector("[data-pb-field='body']")!.innerHTML).toBe("<p>new</p>");
    teardown();
  });

  it("ignores unknown messages from the parent", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-field="body">keep</div>`;
    const teardown = initPreviewBridge({ target, badge: false });
    window.dispatchEvent(new MessageEvent("message", { data: { type: "paperboy:bogus", field: "body", html: "x" } }));
    expect(document.querySelector("[data-pb-field='body']")!.innerHTML).toBe("keep");
    teardown();
  });
});
