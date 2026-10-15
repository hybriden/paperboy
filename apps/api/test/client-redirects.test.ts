import { matchRedirect as clientMatch, normalizeRedirectPath } from "@paperboycms/client";
import { type RedirectManifest, matchRedirect as sharedMatch, normalizePath } from "@paperboy/shared";
import { describe, expect, it } from "vitest";

/**
 * The redirect matcher exists twice: @paperboy/shared (the CMS — test URL,
 * chain checks, the 404 log's "covered by") and @paperboycms/client (published,
 * dependency-free, what frontends run). If they drift, the admin's "Test a URL"
 * stops telling the truth about what visitors get. Same inputs, same answers.
 */
const manifest: RedirectManifest = {
  version: 1,
  rules: [
    { id: 1, from: "/old", match: "exact", to: "/new", status: 301, keepQuery: true },
    { id: 2, from: "/blog", match: "prefix", to: "/artikler", status: 301, keepQuery: true },
    { id: 3, from: "/blog/2020", match: "prefix", to: "https://archive.example.com/2020", status: 308, keepQuery: false },
    { id: 4, from: "/gone", match: "exact", to: null, status: 410, keepQuery: true },
    { id: 5, from: "/blog/special", match: "exact", to: "/special?ref=blog", status: 302, keepQuery: true },
    { id: 6, from: "/ørret", match: "exact", to: "/fisk", status: 301, keepQuery: true },
  ],
};

const cases = [
  "/old", "/OLD/", "/old?x=1", "/old#frag", "/blog", "/blog/", "/blog/a/b?utm=1", "/blogger", "/blog/2020/post?x=1",
  "/blog/special?y=2", "/gone", "/gone/", "/nothing", "/", "//old", "/%C3%B8rret", "/Ørret", "/%E0%A4%A", "",
];

describe("redirect matcher parity (shared ↔ client)", () => {
  it.each(cases)("%s", (path) => {
    expect(clientMatch(manifest, path)).toEqual(sharedMatch(manifest, path));
    expect(normalizeRedirectPath(path)).toBe(normalizePath(path));
  });

  it("answers what the rules say", () => {
    expect(clientMatch(manifest, "/blog/a/b?utm=1")?.location).toBe("/artikler/a/b?utm=1");
    expect(clientMatch(manifest, "/blog/2020/post?x=1")?.location).toBe("https://archive.example.com/2020/post");
    expect(clientMatch(manifest, "/blog/special?y=2")?.location).toBe("/special?ref=blog&y=2");
    expect(clientMatch(manifest, "/gone")).toMatchObject({ status: 410, location: null });
    expect(clientMatch(manifest, "/blogger")).toBeNull();
    expect(clientMatch(manifest, "/%C3%B8rret")?.location).toBe("/fisk");
  });
});
