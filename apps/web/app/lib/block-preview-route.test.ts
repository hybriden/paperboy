import { describe, expect, it, vi } from "vitest";

// The standalone block preview route is EDITOR CHROME: without preview
// credentials it must 404 — before any delivery fetch — or drafts leak by
// documentId enumeration on the public site. This pins the gate's order.

vi.mock("next/headers", () => ({
  draftMode: async () => ({ isEnabled: false }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("./delivery", () => ({
  fetchById: vi.fn(() => {
    throw new Error("fetchById must not run before the preview gate");
  }),
}));

import BlockPreviewPage from "../[locale]/preview/block/[documentId]/page";
import { fetchById } from "./delivery";
import { standaloneAreaBlock } from "./standalone-block";

describe("standalone block preview route — auth gate", () => {
  it("404s without preview credentials, before any delivery fetch", async () => {
    await expect(
      BlockPreviewPage({
        params: Promise.resolve({ locale: "en", documentId: "blk1" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fetchById).not.toHaveBeenCalled();
  });

  it("404s when the pb secret is wrong (constant-time compare, no fetch)", async () => {
    await expect(
      BlockPreviewPage({
        params: Promise.resolve({ locale: "en", documentId: "blk1" }),
        searchParams: Promise.resolve({ pb: "not-the-secret" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fetchById).not.toHaveBeenCalled();
  });

  it("with valid credentials it fetches through the PREVIEW client (drafts perspective)", async () => {
    // The dev default secret verifies outside production — the same path a
    // local editor uses.
    vi.mocked(fetchById).mockResolvedValueOnce({
      documentId: "blk1",
      type: "HeroBlock",
      kind: "block",
      locale: "en",
      name: "A hero",
      slug: null,
      urlPath: null,
      cv: 1,
      data: {},
      fieldTypes: {},
      seo: null,
    } as never);
    await BlockPreviewPage({
      params: Promise.resolve({ locale: "en", documentId: "blk1" }),
      searchParams: Promise.resolve({ pb: "dev-preview-secret-change-me" }),
    });
    expect(fetchById).toHaveBeenCalledWith("blk1", "en", true);
  });

  it("the wrapper supplies every field the AreaBlock content contract declares", () => {
    const b = standaloneAreaBlock({
      documentId: "blk1",
      type: "HeroBlock",
      kind: "block",
      locale: "en",
      name: "A hero",
      slug: null,
      urlPath: null,
      cv: 1,
      data: {},
      fieldTypes: {},
      seo: null,
    } as never);
    // Key-completeness: a field the renderer starts reading off resolved
    // shared entries must be mapped here too, or standalone drifts from inline.
    expect(Object.keys(b.content ?? {}).sort()).toEqual(
      ["data", "documentId", "fieldTypes", "form", "kind", "name", "type", "urlPath"].sort(),
    );
  });
});
