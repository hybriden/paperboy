import { describe, expect, it } from "vitest";
import { focusMessage, parsePreviewMessage, patchMessage } from "./protocol.js";

describe("parsePreviewMessage", () => {
  it("accepts known message types", () => {
    expect(parsePreviewMessage({ type: "paperboy:edit", field: "x" })?.type).toBe("paperboy:edit");
    expect(parsePreviewMessage({ type: "paperboy:drop", field: "a", payload: {} })?.type).toBe("paperboy:drop");
    expect(parsePreviewMessage({ type: "paperboy:patch", field: "b", html: "x" })?.type).toBe("paperboy:patch");
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
