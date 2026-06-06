import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_KEY, PUBLIC_KEY, type Suite, setupApi } from "./helpers.js";

/**
 * CONTRACT FREEZE — golden-shape snapshots of the Delivery API.
 *
 * The seed regenerates random 24-char nanoid documentIds + ISO timestamps + cv
 * numbers on every run, so a raw snapshot would be unstable. `normalize()` walks
 * the response JSON and rewrites every run-dependent value to a stable placeholder
 * (<id-N> in first-encounter order, <ts>, <cv>) so the snapshot pins ONLY the
 * delivered field exposure + shape. Any future change to what delivery exposes —
 * a new field, a renamed field, a private field leaking — becomes a snapshot diff.
 */

const pub = { authorization: `Bearer ${PUBLIC_KEY}` };
const prev = { authorization: `Bearer ${PREVIEW_KEY}` };

// 24-char nanoid alphabet ids (A-Za-z0-9_-). Seed ids are exactly 24 chars.
const ID_RE = /^[A-Za-z0-9_-]{24}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Field names that hold an id (documentId-shaped string) — also normalize ids
// that appear as bare values anywhere in `data` (e.g. a reference field value).
const ID_KEYS = new Set(["documentId", "ref", "parentId", "id"]);

interface NormCtx {
  ids: Map<string, string>;
}

function idPlaceholder(ctx: NormCtx, raw: string): string {
  let p = ctx.ids.get(raw);
  if (!p) {
    p = `<id-${ctx.ids.size + 1}>`;
    ctx.ids.set(raw, p);
  }
  return p;
}

function normalizeValue(ctx: NormCtx, key: string | null, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => normalizeValue(ctx, null, v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeValue(ctx, k, v);
    }
    return out;
  }
  if (typeof value === "string") {
    // Explicit id-bearing fields → stable id placeholder.
    if (key && ID_KEYS.has(key) && ID_RE.test(value)) return idPlaceholder(ctx, value);
    // Timestamps anywhere.
    if (ISO_RE.test(value)) return "<ts>";
    // Bare nanoid-shaped values that appear inside data (e.g. reference values,
    // image documentIds). Only collapse if it already maps OR looks exactly like
    // a 24-char id to avoid eating ordinary 24-char content strings — content in
    // the seed never matches the strict id alphabet+length by accident.
    if (ID_RE.test(value)) return idPlaceholder(ctx, value);
    return value;
  }
  if (typeof key === "string" && key === "cv" && typeof value === "number") return "<cv>";
  return value;
}

function normalize(body: unknown): unknown {
  const ctx: NormCtx = { ids: new Map() };
  return normalizeValue(ctx, null, body);
}

/** Recursively collect every string key + string value for leak assertions. */
function walkStrings(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const v of value) walkStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      walkStrings(v, out);
    }
  } else if (typeof value === "string") {
    out.push(value);
  }
}

describe("Delivery API — golden-shape contract freeze", () => {
  let s: Suite;
  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("GET /delivery/content/:homeId populate=0 (public) — frozen shape", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en&populate=0`,
      headers: pub,
    });
    expect(res.statusCode).toBe(200);
    expect(normalize(res.json())).toMatchSnapshot();
  });

  it("GET /delivery/content/:homeId populate=2 (public) — frozen shape", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en&populate=2`,
      headers: pub,
    });
    expect(res.statusCode).toBe(200);
    expect(normalize(res.json())).toMatchSnapshot();
  });

  it("GET /delivery/content/:homeId populate=0 (preview) — frozen shape", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en&populate=0`,
      headers: prev,
    });
    expect(res.statusCode).toBe(200);
    expect(normalize(res.json())).toMatchSnapshot();
  });

  it("GET /delivery/content/:homeId populate=2 (preview) — frozen shape", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/delivery/content/${s.ids.homeId}?locale=en&populate=2`,
      headers: prev,
    });
    expect(res.statusCode).toBe(200);
    expect(normalize(res.json())).toMatchSnapshot();
  });

  it("GET /delivery/content?type=BlogPost (public) — frozen shape", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: "/api/v1/delivery/content?type=BlogPost&locale=en&populate=1&sort=data.publishDate",
      headers: pub,
    });
    expect(res.statusCode).toBe(200);
    expect(normalize(res.json())).toMatchSnapshot();
  });

  it("GET /delivery/globals/:type (public) — frozen shape", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: "/api/v1/delivery/globals/SiteSettings?locale=en",
      headers: pub,
    });
    expect(res.statusCode).toBe(200);
    expect(normalize(res.json())).toMatchSnapshot();
  });

  it("GET /delivery/start (public) — frozen shape", async () => {
    const res = await s.app.inject({
      method: "GET",
      url: "/api/v1/delivery/start?locale=en&populate=2",
      headers: pub,
    });
    expect(res.statusCode).toBe(200);
    expect(normalize(res.json())).toMatchSnapshot();
  });

  it("NO delivery:'private' field name (from the seeded types) ever appears in any public response", async () => {
    // The seed marks these field names delivery:"private":
    //   ArticlePage.seoNotes, SiteSettings.internalNote
    // (and their values). Walk every public response and assert neither the key
    // nor its known seeded value is present anywhere.
    const PRIVATE_KEYS = ["seoNotes", "internalNote"];
    const PRIVATE_VALUES = ["INTERNAL: ops contact — not exposed publicly."];

    const responses: unknown[] = [];
    const urls = [
      `/api/v1/delivery/content/${s.ids.homeId}?locale=en&populate=2`,
      `/api/v1/delivery/content/${s.ids.authorZoneId}?locale=en&populate=2`,
      "/api/v1/delivery/content?type=BlogPost&locale=en&populate=2",
      "/api/v1/delivery/content?type=ArticlePage&locale=en&populate=2",
      "/api/v1/delivery/globals/SiteSettings?locale=en",
      "/api/v1/delivery/start?locale=en&populate=2",
    ];
    for (const url of urls) {
      const res = await s.app.inject({ method: "GET", url, headers: pub });
      if (res.statusCode === 200) responses.push(res.json());
    }
    expect(responses.length).toBeGreaterThan(0);

    const strings: string[] = [];
    for (const r of responses) walkStrings(r, strings);
    const haystack = new Set(strings);

    for (const k of PRIVATE_KEYS) {
      expect(haystack.has(k), `private field name "${k}" leaked into a public response`).toBe(false);
    }
    for (const v of PRIVATE_VALUES) {
      expect(haystack.has(v), `private field VALUE leaked into a public response: ${v}`).toBe(false);
    }
  });
});
