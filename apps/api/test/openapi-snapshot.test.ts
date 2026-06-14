import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, setupApi } from "./helpers.js";

/**
 * CONTRACT FREEZE — the whole API surface, as a STABLE digest of the OpenAPI doc.
 *
 * For every path+method we extract only run-INDEPENDENT facts: summary/tags,
 * required path+query params, request-body required fields, and the property
 * names of the 200 response schema. Everything is sorted alphabetically so the
 * snapshot is deterministic. Adding a route is a visible diff; removing/renaming
 * a response field fails loudly.
 */

type JsonObj = Record<string, unknown>;

function asObj(v: unknown): JsonObj {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObj) : {};
}

/** Resolve a local "#/components/..." $ref against the doc; else return as-is. */
function deref(doc: JsonObj, schema: unknown, seen = new Set<string>()): JsonObj {
  const s = asObj(schema);
  const ref = s.$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    if (seen.has(ref)) return {}; // cycle guard
    seen.add(ref);
    const parts = ref.slice(2).split("/");
    let cur: unknown = doc;
    for (const p of parts) cur = asObj(cur)[p];
    return deref(doc, cur, seen);
  }
  return s;
}

/** Collect property names of an object schema (following $ref and allOf). */
function propertyNames(doc: JsonObj, schema: unknown, seen = new Set<string>()): string[] {
  const s = deref(doc, schema, seen);
  const names = new Set<string>();
  const props = asObj(s.properties);
  for (const k of Object.keys(props)) names.add(k);
  for (const part of (Array.isArray(s.allOf) ? s.allOf : []) as unknown[]) {
    for (const n of propertyNames(doc, part, seen)) names.add(n);
  }
  // For array responses, descend into items so we still pin the element shape.
  if (s.type === "array" && s.items) {
    for (const n of propertyNames(doc, s.items, seen)) names.add(`[]${n}`);
  }
  return [...names].sort();
}

function requiredOf(doc: JsonObj, schema: unknown): string[] {
  const s = deref(doc, schema);
  const req = Array.isArray(s.required) ? (s.required as string[]) : [];
  return [...req].sort();
}

describe("OpenAPI surface — stable digest snapshot", () => {
  let s: Suite;
  beforeAll(async () => {
    s = await setupApi();
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("serves the OpenAPI JSON over HTTP (/api/docs/json)", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/docs/json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as JsonObj;
    expect(doc.openapi).toBe("3.1.0");
    expect(asObj(doc.paths)).toBeTruthy();
  });

  it("digest of every path+method is frozen", async () => {
    // app.swagger() returns the same document the HTTP route serializes — used
    // directly so the digest is independent of any serialization quirks.
    const doc = (s.app as unknown as { swagger: () => JsonObj }).swagger();
    const paths = asObj(doc.paths);

    const digest: Record<string, unknown> = {};
    for (const route of Object.keys(paths).sort()) {
      const methods = asObj(paths[route]);
      for (const method of Object.keys(methods).sort()) {
        const op = asObj(methods[method]);

        // Required params (path + query), by name.
        const params = (Array.isArray(op.parameters) ? op.parameters : []) as JsonObj[];
        const requiredParams = params
          .filter((p) => p.required === true)
          .map((p) => `${p.in as string}:${p.name as string}`)
          .sort();

        // Request body required fields.
        const rb = asObj(op.requestBody);
        const rbSchema = asObj(asObj(asObj(rb.content)["application/json"]).schema);
        const requestBodyRequired = requiredOf(doc, rbSchema);

        // 200 response property names.
        const resp200 = asObj(asObj(op.responses)["200"]);
        const resp200Schema = asObj(asObj(asObj(resp200.content)["application/json"]).schema);
        const response200Props = propertyNames(doc, resp200Schema);

        digest[`${method.toUpperCase()} ${route}`] = {
          summary: typeof op.summary === "string" ? op.summary : null,
          tags: Array.isArray(op.tags) ? [...(op.tags as string[])].sort() : [],
          requiredParams,
          requestBodyRequired,
          response200Props,
        };
      }
    }

    // Re-key into a sorted object so the snapshot ordering is deterministic.
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(digest).sort()) sorted[k] = digest[k];

    expect(sorted).toMatchSnapshot();
  });
});
