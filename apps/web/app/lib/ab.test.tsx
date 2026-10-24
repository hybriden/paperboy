import { assignArm, type DeliveryContent } from "@paperboycms/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Renderer } from "../components/Renderer";
import { experimentView, mayRememberVisitor, visitorCookieAction, visitorKey } from "./ab";

const jar = (c: Record<string, string>) => ({ get: (n: string) => (n in c ? { value: c[n]! } : undefined) });
const consentEnv = { PAPERBOY_AB_MODE: "consent" };

describe("visitor key", () => {
  it("cookieless (default): a fresh key per page view, even with a pb_vid and consent", () => {
    const c = jar({ pb_vid: "remembered", pb_consent: "1" });
    const a = visitorKey(c, {});
    expect(a).not.toBe("remembered");
    expect(visitorKey(c, {})).not.toBe(a);
    expect(visitorCookieAction(c, {})).toBe("delete");
  });

  it("consent mode remembers pb_vid only while the consent cookie says yes", () => {
    expect(visitorKey(jar({ pb_vid: "v1", pb_consent: "1" }), consentEnv)).toBe("v1");
    expect(visitorKey(jar({ pb_vid: "v1", pb_consent: "true" }), consentEnv)).toBe("v1");
    expect(visitorKey(jar({ pb_vid: "v1", pb_consent: "0" }), consentEnv)).not.toBe("v1");
    expect(visitorKey(jar({ pb_vid: "v1" }), consentEnv)).not.toBe("v1");
  });

  it("the proxy mints pb_vid on consent, deletes it without, and honours a custom consent cookie name", () => {
    expect(visitorCookieAction(jar({ pb_consent: "1" }), consentEnv)).toBe("set");
    expect(visitorCookieAction(jar({ pb_consent: "1", pb_vid: "v" }), consentEnv)).toBeNull();
    expect(visitorCookieAction(jar({ pb_vid: "v" }), consentEnv)).toBe("delete");
    expect(visitorCookieAction(jar({}), consentEnv)).toBeNull();
    const env = { ...consentEnv, PAPERBOY_AB_CONSENT_COOKIE: "cmp_ok" };
    expect(mayRememberVisitor(jar({ cmp_ok: "true" }), env)).toBe(true);
    expect(mayRememberVisitor(jar({ pb_consent: "1" }), env)).toBe(false);
  });
});

const block = (title: string) => ({ blockType: "CardBlock", display: "auto", shared: false, data: { title } });
const arms = [{ key: "a" as const, weight: 50 }, { key: "b" as const, weight: 50, blocks: [block("Version B")] }];
const page: DeliveryContent = {
  documentId: "doc1",
  type: "StandardPage",
  kind: "page",
  locale: "en",
  name: "Test",
  slug: "test",
  urlPath: "/test",
  cv: 1,
  data: { mainArea: [block("Version A")] },
  fieldTypes: { mainArea: "contentArea" },
  seo: null,
  experiments: [{ id: 42, area: "mainArea", goal: "form", arms }],
};
/** The first key that assignArm puts in `arm`. */
const keyFor = (arm: string): string => {
  for (let i = 0; ; i++) if (assignArm(42, `k${i}`, arms) === arm) return `k${i}`;
};

describe("experimentView", () => {
  it("two visitors assigned A and B get the two different renders, and each is counted", () => {
    const html = (arm: string) => {
      const v = experimentView(page, { preview: false, visitorKey: () => keyFor(arm) });
      expect(v.exposures).toEqual([{ experimentId: 42, arm }]);
      return renderToStaticMarkup(<Renderer content={v.item} experiments={v.exposures} />);
    };
    const a = html("a");
    const b = html("b");
    expect(a).toContain("Version A");
    expect(a).not.toContain("Version B");
    expect(b).toContain("Version B");
    expect(b).not.toContain("Version A");
  });

  it("preview shows the forced version (or A) and is never counted", () => {
    const forced = experimentView(page, { preview: true, pbab: "42:b", visitorKey: () => keyFor("a") });
    expect(forced.exposures).toEqual([]);
    expect(JSON.stringify(forced.item.data)).toContain("Version B");
    const plain = experimentView(page, { preview: true, visitorKey: () => keyFor("b") });
    expect(plain.exposures).toEqual([]);
    expect(JSON.stringify(plain.item.data)).toContain("Version A");
  });

  it("pbab outside preview is ignored: the visitor key decides", () => {
    const v = experimentView(page, { preview: false, pbab: "42:b", visitorKey: () => keyFor("a") });
    expect(v.exposures).toEqual([{ experimentId: 42, arm: "a" }]);
  });

  it("a page without experiments is untouched and never mints a key", () => {
    const plain = { ...page, experiments: undefined };
    const v = experimentView(plain, { preview: false, visitorKey: () => { throw new Error("no key needed"); } });
    expect(v).toEqual({ item: plain, exposures: [] });
  });
});
