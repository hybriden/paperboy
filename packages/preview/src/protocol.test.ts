import { describe, expect, it } from "vitest";
import { focusMessage, parsePreviewMessage, patchMessage } from "./protocol.js";

describe("parsePreviewMessage", () => {
  it("accepts known message types", () => {
    expect(parsePreviewMessage({ type: "paperboy:edit", field: "x" })?.type).toBe("paperboy:edit");
    expect(parsePreviewMessage({ type: "paperboy:drop", field: "a", payload: {} })?.type).toBe("paperboy:drop");
    expect(parsePreviewMessage({ type: "paperboy:patch", field: "b", html: "x" })?.type).toBe("paperboy:patch");
  });

  it("accepts paperboy:add-block (the area add chip → admin palette)", () => {
    const msg = parsePreviewMessage({ type: "paperboy:add-block", field: "mainArea", rect: { x: 0, y: 0, w: 10, h: 10 } });
    expect(msg?.type).toBe("paperboy:add-block");
    expect((msg as { field?: string }).field).toBe("mainArea");
  });

  it("ignores unknown paperboy:* types (forward-compat / version skew)", () => {
    expect(parsePreviewMessage({ type: "paperboy:future-thing", field: "x" })).toBeNull();
  });

  it("ignores non-protocol / garbage data", () => {
    expect(parsePreviewMessage(null)).toBeNull();
    expect(parsePreviewMessage("paperboy:edit")).toBeNull();
    expect(parsePreviewMessage({ type: 42 })).toBeNull();
    expect(parsePreviewMessage({ foo: 1 })).toBeNull();
  });

  it("rejects a non-integer blockIndex — it is interpolated into a querySelector by the bridge", () => {
    // A number always yields a valid selector; only a string with `"`/`\` could
    // throw inside the message listener. blockIndex is number|null by contract,
    // so anything else is a version-skewed or hostile sender — refuse it.
    expect(parsePreviewMessage({ type: "paperboy:patch", field: "b", blockIndex: '"] , [x' })).toBeNull();
    expect(parsePreviewMessage({ type: "paperboy:focus", field: "b", blockIndex: 1.5 })).toBeNull();
    // null and integer stay valid.
    expect(parsePreviewMessage({ type: "paperboy:focus", field: "b", blockIndex: null })?.type).toBe("paperboy:focus");
    expect(parsePreviewMessage({ type: "paperboy:patch", field: "b", html: "x", blockIndex: 3 })?.type).toBe("paperboy:patch");
  });
});

describe("message builders", () => {
  it("patchMessage carries html or text", () => {
    expect(patchMessage("body", { html: "<p>x</p>" })).toEqual({ type: "paperboy:patch", field: "body", html: "<p>x</p>" });
    expect(patchMessage("title", { text: "hi" })).toEqual({ type: "paperboy:patch", field: "title", text: "hi" });
  });

  it("focusMessage", () => {
    expect(focusMessage("title")).toEqual({ type: "paperboy:focus", field: "title" });
  });
});
