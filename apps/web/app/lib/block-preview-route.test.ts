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
});
