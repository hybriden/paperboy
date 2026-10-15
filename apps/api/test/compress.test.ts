import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Suite, setupApi } from "./helpers.js";

/**
 * The admin's nginx gzipped API JSON on the fly (gzip_types application/json).
 * With the api answering browsers directly, it compresses its own responses —
 * a platform such as App Service or Container Apps does not do it for us.
 */
const BUNDLE = `console.log("admin bundle");`.repeat(200);

let suite: Suite;
beforeAll(async () => {
  const dist = mkdtempSync(join(tmpdir(), "paperboy-admin-dist-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>admin</title>");
  writeFileSync(join(dist, "assets", "app-abc123.js"), BUNDLE);
  writeFileSync(join(dist, "assets", "app-abc123.js.gz"), gzipSync(BUNDLE));
  suite = await setupApi({ ADMIN_DIST_DIR: dist });
});
afterAll(async () => {
  await suite.app.close();
});

describe("response compression", () => {
  it("gzips a JSON response for a client that accepts gzip", async () => {
    const res = await suite.app.inject({ method: "GET", url: "/api/docs/json", headers: { "accept-encoding": "gzip" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(String(res.headers.vary)).toMatch(/accept-encoding/i);
    expect(JSON.parse(gunzipSync(res.rawPayload).toString()).openapi).toBe("3.1.0");
  });

  it("sends JSON uncompressed to a client that does not ask for it", async () => {
    const res = await suite.app.inject({ method: "GET", url: "/api/docs/json", headers: { "accept-encoding": "identity" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.json().openapi).toBe("3.1.0");
  });

  it("serves a pre-compressed admin asset once, not gzipped twice", async () => {
    const res = await suite.app.inject({ method: "GET", url: "/assets/app-abc123.js", headers: { "accept-encoding": "gzip" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(res.rawPayload).toString()).toBe(BUNDLE);
  });

  it("leaves a small response alone (not worth the CPU)", async () => {
    const res = await suite.app.inject({ method: "GET", url: "/health", headers: { "accept-encoding": "gzip" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
  });
});
