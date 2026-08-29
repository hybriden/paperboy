import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeliveryContent } from "@paperboy/shared";
import { standaloneAreaBlock } from "../lib/standalone-block";
import { StandaloneBlock } from "./Renderer";

// The standalone block preview route (/{locale}/preview/block/{documentId}) —
// part of the documented preview contract — renders one delivered document
// through the SAME Block component pages use inline. These pin the wrapping:
// a drift here means the editor previews something pages won't show.

function blockDoc(over: Partial<DeliveryContent> = {}): DeliveryContent {
  return {
    documentId: "blk1",
    type: "HeroBlock",
    kind: "block",
    locale: "en",
    name: "A hero",
    slug: null,
    urlPath: null,
    cv: 1,
    data: { title: "Deliver anywhere", subtitle: "Standalone" },
    fieldTypes: { title: "text", subtitle: "text" },
    seo: null,
    ...over,
  } as DeliveryContent;
}

describe("standalone block preview", () => {
  it("wraps a delivered document exactly as an inline shared-block entry", () => {
    const doc = blockDoc();
    const b = standaloneAreaBlock(doc);
    expect(b.shared).toBe(true);
    expect(b.blockType).toBe("HeroBlock");
    // Everything Block reads off a resolved shared entry must be present —
    // documentId (Form submissions post against it), data, fieldTypes, form.
    expect(b.content).toMatchObject({
      documentId: "blk1",
      type: "HeroBlock",
      kind: "block",
      name: "A hero",
      data: { title: "Deliver anywhere", subtitle: "Standalone" },
    });
  });

  it("renders an ordinary block with its real inline component", () => {
    const html = renderToStaticMarkup(<StandaloneBlock content={blockDoc()} locale="en" preview />);
    expect(html).toContain('data-block="HeroBlock"');
    expect(html).toContain("Deliver anywhere");
  });

  it("renders a FORM standalone — the real form, fields and all", () => {
    const doc = blockDoc({
      documentId: "form1",
      type: "Form",
      name: "Contact",
      data: { title: "Contact us" },
      fieldTypes: { title: "text" },
      form: {
        title: "Contact us",
        fields: [
          { kind: "text", name: "fullName", label: "Your name", required: true },
          { kind: "email", name: "email", label: "Email", required: true },
        ],
        submitLabel: "Send",
        confirmation: "message",
        turnstile: false,
        honeypotField: "pb_contact_reason",
        minFillMs: 2500,
      },
    });
    const html = renderToStaticMarkup(<StandaloneBlock content={doc} locale="en" preview />);
    expect(html).toContain('data-block="Form"');
    expect(html).toContain("Your name");
    expect(html).toContain("Email");
    expect(html).toContain("Send");
  });
});
