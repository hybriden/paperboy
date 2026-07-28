import { describe, expect, it } from "vitest";
import { type FieldDef, LinkValue, coerceFieldValue, isSafeUrl } from "@paperboy/shared";

/**
 * A scheme check must survive the HTML URL parser's own normalisation.
 *
 * `isSafeUrl` tested `/^([a-z][a-z0-9+.-]*:)/i` against `raw.trim()`. Two gaps,
 * both of which resolve back to `javascript:` in a real browser:
 *
 *  - The URL parser STRIPS ASCII tab/LF/CR from ANYWHERE in a URL. So
 *    `java<TAB>script:alert(1)` breaks the regex (no scheme matched → treated as
 *    a harmless relative URL → stored), and the browser then executes it.
 *  - It also strips LEADING C0 controls. JS `trim()` removes whitespace but not
 *    `\x00`/`\x01`, so `\x01javascript:alert(1)` also slipped through.
 *
 * Verified before the fix: `java\tscript:`, `java\nscript:`, `java\rscript:`,
 * `\x00javascript:` and `\x01javascript:` were all KEPT on a richtext link mark
 * and served verbatim by the PUBLIC Delivery API. `@paperboycms/client` happens
 * to block them at render, but every documented self-render path (Astro
 * `set:html`, Vue, `generateHTML`) shipped live stored XSS — writable by the
 * lowest content role and by any prompt-injected agent.
 *
 * The fix rejects the whole class rather than the known instances: a URL
 * containing ASCII control characters is never legitimate authored content.
 * Internal SPACES stay allowed — the parser percent-encodes them rather than
 * removing them, so they cannot smuggle a scheme, and real links contain them.
 */
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);
const VT = String.fromCharCode(11);
const DEL = String.fromCharCode(127);

const SMUGGLED = [
  `java${TAB}script:alert(1)`,
  `java${LF}script:alert(1)`,
  `java${CR}script:alert(1)`,
  `java${VT}script:alert(1)`,
  `${NUL}javascript:alert(1)`,
  `${SOH}javascript:alert(1)`,
  `${TAB}${TAB}javascript:alert(1)`,
  `data${TAB}:text/html,<script>alert(1)</script>`,
  `vb${LF}script:msgbox(1)`,
  `javascript${TAB}:alert(1)`,
  `javascript:${DEL}alert(1)`,
];

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

const doc = (href: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "click", marks: [{ type: "link", attrs: { href } }] }] }],
});

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

describe("isSafeUrl rejects control-character scheme smuggling", () => {
  it("refuses every smuggled variant", () => {
    for (const href of SMUGGLED) {
      expect(isSafeUrl(href), `${JSON.stringify(href)} was accepted`).toBe(false);
    }
  });

  it("still accepts the legitimate shapes, including internal spaces", () => {
    for (const href of [
      "https://example.com/a?b=1#c",
      "http://example.com",
      "mailto:a@b.c",
      "tel:+4712345678",
      "/relative",
      "#anchor",
      "docs/x",
      "x",
      "",
      "https://example.com/a b", // parser percent-encodes the space; can't form a scheme
      "https://exämple.com/π",
    ]) {
      expect(isSafeUrl(href), `${JSON.stringify(href)} was wrongly rejected`).toBe(true);
    }
  });
});

describe("the richtext write chokepoint drops smuggled link marks", () => {
  it("keeps the text but never the href", () => {
    for (const href of SMUGGLED) {
      const out = coerceFieldValue(richtext, doc(href));
      expect(linkHrefs(out), `${JSON.stringify(href)} survived`).toEqual([]);
      expect(JSON.stringify(out), "visible text must not be destroyed").toContain("click");
    }
  });

  it("closes the markdown carrier for the same trick", () => {
    const out = coerceFieldValue(richtext, `[click](java${TAB}script:alert(1))`);
    expect(linkHrefs(out)).toEqual([]);
  });
});

describe("the structured link field refuses them too", () => {
  it("rejects at validation, with the self-teaching message", () => {
    for (const href of SMUGGLED) {
      const parsed = LinkValue.safeParse({ href });
      expect(parsed.success, `${JSON.stringify(href)} was accepted`).toBe(false);
    }
    expect(LinkValue.safeParse({ href: "https://example.com" }).success).toBe(true);
  });
});
