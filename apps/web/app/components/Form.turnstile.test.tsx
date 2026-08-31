import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FormSpec } from "@paperboycms/client";
import { Form } from "./Form";

// A `turnstile: true` form rendered a `.cf-turnstile` div but nothing ever
// loaded the Turnstile API, so the widget never appeared, the token stayed ""
// and the CMS refused every submission (by design — it never accepts an
// unverifiable challenge).
const spec = (turnstile: boolean): FormSpec => ({
  title: "Contact",
  fields: [{ kind: "text", name: "fullName", label: "Your name", required: true }],
  submitLabel: "Send",
  confirmation: "message",
  turnstile,
  honeypotField: "pb_contact_reason",
  minFillMs: 2500,
});
const action = () => Promise.resolve({ ok: true as const, confirmation: { type: "message" } });
const TURNSTILE_API = "https://challenges.cloudflare.com/turnstile/v0/api.js";

describe("Form — Turnstile", () => {
  it("loads the Turnstile API and renders the widget when the form asks for a challenge", () => {
    const html = renderToStaticMarkup(<Form spec={spec(true)} formId="f1" action={action} turnstileSiteKey="1x00000000000000000000AA" />);
    expect(html).toContain(`src="${TURNSTILE_API}"`);
    expect(html).toContain('class="cf-turnstile"');
    expect(html).toContain('data-sitekey="1x00000000000000000000AA"');
  });

  it("renders neither the script nor the widget when the form does not ask for one", () => {
    const html = renderToStaticMarkup(<Form spec={spec(false)} formId="f1" action={action} turnstileSiteKey="1x00000000000000000000AA" />);
    expect(html).not.toContain(TURNSTILE_API);
    expect(html).not.toContain("cf-turnstile");
  });

  it("says the site key is missing instead of rendering a dead widget", () => {
    const html = renderToStaticMarkup(<Form spec={spec(true)} formId="f1" action={action} />);
    expect(html).not.toContain(TURNSTILE_API);
    expect(html).not.toContain("cf-turnstile");
    expect(html).toContain("NEXT_PUBLIC_TURNSTILE_SITE_KEY");
  });
});
