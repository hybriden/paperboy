import { describe, expect, it } from "vitest";
import { type FormSpec, formToolAttrs, honeypotAttrs } from "./index.js";

const spec = (over: Partial<FormSpec> = {}): FormSpec => ({
  title: "Contact us",
  fields: [],
  submitLabel: "Send",
  confirmation: "message",
  turnstile: false,
  honeypotField: "pb_hp_website",
  minFillMs: 2000,
  ...over,
});

describe("WebMCP form tools (#119)", () => {
  it("names the tool from the title and describes it from the intro", () => {
    expect(formToolAttrs(spec({ intro: "We answer within a day." }))).toEqual({
      toolname: "contact_us",
      tooldescription: "Contact us: We answer within a day.",
    });
  });

  it("reads a richtext intro as plain text and falls back to the title", () => {
    const intro = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Ask " }, { type: "text", text: "anything." }] }, { type: "paragraph", content: [{ type: "text", text: "We reply fast." }] }] };
    expect(formToolAttrs(spec({ intro })).tooldescription).toBe("Contact us: Ask anything. We reply fast.");
    expect(formToolAttrs(spec()).tooldescription).toBe('Fill in the "Contact us" form');
  });

  it("keeps the tool name inside the allowed alphabet, never empty", () => {
    expect(formToolAttrs(spec({ title: "Kontakt oss – Ærlig talt!" })).toolname).toMatch(/^[a-z0-9_]+$/);
    expect(formToolAttrs(spec({ title: "!!!" })).toolname).toBe("form");
    expect(formToolAttrs(spec({ title: "x".repeat(300) })).toolname).toHaveLength(128);
  });

  it("never asks the agent to submit by itself", () => {
    expect(formToolAttrs(spec())).not.toHaveProperty("toolautosubmit");
  });

  it("keeps the honeypot out of the tool: readonly is what Chrome leaves out of the schema", () => {
    // Verified in Chromium 156 with --enable-features=WebMCPTesting: aria-hidden,
    // display:none and [hidden] controls are all offered to the agent; readonly
    // and disabled are not, and an agent setting a readonly control is refused.
    expect(honeypotAttrs(spec()).input).toMatchObject({ name: "pb_hp_website", readOnly: true });
  });
});
