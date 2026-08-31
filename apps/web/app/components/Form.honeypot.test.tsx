import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FormSpec } from "@paperboycms/client";
import { Form } from "./Form";

// The honeypot must be hidden from sight AND from assistive technology. Only
// the input carried aria-hidden; its wrapper (with the "Leave this field empty"
// label) was merely offscreen, so a screen reader in browse mode still read the
// label — and a visitor who followed it would fail the spam check.
const spec: FormSpec = {
  title: "Contact",
  fields: [{ kind: "text", name: "fullName", label: "Your name", required: true }],
  submitLabel: "Send",
  confirmation: "message",
  turnstile: false,
  honeypotField: "pb_contact_reason",
  minFillMs: 2500,
};

describe("Form — honeypot", () => {
  it("hides the honeypot wrapper (label included) from assistive technology", () => {
    const html = renderToStaticMarkup(<Form spec={spec} formId="form1" action={() => Promise.resolve({ ok: true, confirmation: { type: "message" } })} />);
    const wrapper = html.match(/<div([^>]*)><label for="pb-hp">/)?.[1] ?? "";
    expect(wrapper).toContain('aria-hidden="true"');
    expect(html).toContain('name="pb_contact_reason"');
  });
});
