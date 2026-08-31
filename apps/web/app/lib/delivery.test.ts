import { describe, expect, it, vi } from "vitest";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@paperboycms/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperboycms/client")>()),
  createClient: () => ({ list }),
}));

import { PaperboyError } from "@paperboycms/client";
import { fetchList } from "./delivery";

// fetchList swallowed EVERY error, so a wrong delivery key (401) rendered as
// silently empty lists. The client itself turns a 404 into `{ items: [] }`.
describe("fetchList", () => {
  it("returns the client's empty list for a missing parent", async () => {
    list.mockResolvedValueOnce({ items: [], total: 0 });
    await expect(fetchList("BlogPost", "en", false, "missing")).resolves.toEqual([]);
  });

  it("rethrows a 401 (bad key) instead of hiding it as an empty list", async () => {
    list.mockRejectedValueOnce(new PaperboyError(401, "Invalid delivery key"));
    await expect(fetchList("BlogPost", "en", false)).rejects.toMatchObject({ status: 401 });
  });

  it("rethrows transport errors", async () => {
    list.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(fetchList("BlogPost", "en", false)).rejects.toThrow("fetch failed");
  });
});
