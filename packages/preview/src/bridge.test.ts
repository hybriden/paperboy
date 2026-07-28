// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initPreviewBridge } from "./bridge.js";

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

  it("posts paperboy:edit when an editable region is clicked", () => {
    const target = makeTarget();
    document.body.innerHTML = `<div data-pb-field="heading">Hi</div>`;
    const teardown = initPreviewBridge({ target, badge: false });
    target.postMessage.mockClear();
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
});
