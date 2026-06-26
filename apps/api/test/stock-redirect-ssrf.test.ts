import { type Server, createServer } from "node:http";
import { downloadBytes } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * S3-M8: the stock-image download followed redirects (undici default), so an
 * allowlisted provider host could 30x-redirect the server to an internal target —
 * the pre-fetch host allowlist then guarded nothing. downloadBytes now follows
 * redirects manually and re-checks each hop's host against the allowlist.
 */
describe("stock download re-validates redirect hosts (SSRF)", () => {
  let server: Server;
  let port = 0;
  const allowed = (h: string) => h === "127.0.0.1"; // the only trusted host in this test

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/start") {
        // Redirect off the allowlist to an internal target (cloud metadata IP).
        res.writeHead(302, { location: "http://169.254.169.254/evil" });
        res.end();
        return;
      }
      if (req.url === "/img") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.from([1, 2, 3, 4]));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => {
    server.close();
  });

  it("blocks a redirect to a non-allowlisted host", async () => {
    await expect(downloadBytes(`http://127.0.0.1:${port}/start`, "Test", allowed)).rejects.toThrow(/untrusted redirect host/i);
  });

  it("downloads normally when no redirect leaves the allowlist", async () => {
    const buf = await downloadBytes(`http://127.0.0.1:${port}/img`, "Test", allowed);
    expect(buf.length).toBe(4);
  });
});
