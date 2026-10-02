import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchPublicFile, schemaTables } from "@paperboy/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DB, type Suite, authHeaders, login, setupApi } from "./helpers.js";
import { McpClient } from "./mcp-stdio-client.js";

/**
 * Getting an agent's files into the media library.
 *
 * Reported live: an agent with ready-made JPGs on the user's disk could not
 * use them — the MCP's only way to add an asset was import_stock_image
 * (Unsplash), so it had to ask the human to upload by hand. A remote MCP server
 * can't read the agent's disk, so there are two doors:
 *  - create_upload_link: a short-lived token the agent curls its files to
 *    (POST /api/v1/uploads), acting as the user who minted it, in that site;
 *  - upload_asset: a public URL (SSRF-guarded) or base64 bytes.
 * Every file goes through the same sniff and size cap as the admin upload.
 */

const PUBLIC_URL = "https://cms.example.org";
const UPLOADS_DIR = `${process.env.TMPDIR ?? "/tmp"}/paperboy-uploads-test`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);

/** multipart/form-data with one `file` part per entry. */
function multipart(files: Array<{ name: string; type: string; data: Buffer }>) {
  const boundary = "----paperboyupload1234567890";
  const parts = files.flatMap((f) => [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`),
    f.data,
    Buffer.from("\r\n"),
  ]);
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]) };
}

describe("MCP: uploading the agent's own files", () => {
  let s: Suite;
  let admin: Awaited<ReturnType<typeof login>>;
  let mcp: McpClient;
  let siteB: string;

  const upload = (token: string | null, files: Array<{ name: string; type: string; data: Buffer }>, extra: Record<string, string> = {}) => {
    const { contentType, body } = multipart(files);
    return s.app.inject({
      method: "POST",
      url: "/api/v1/uploads",
      headers: { "content-type": contentType, ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
      payload: body,
    });
  };
  const newLink = async () => {
    const res = await mcp.call("create_upload_link");
    expect(res.isError, res.text).toBe(false);
    return res.json as { uploadUrl: string; headers: { Authorization: string }; expiresAt: string; example: string };
  };
  const tokenOf = (link: { headers: { Authorization: string } }) => link.headers.Authorization.replace(/^Bearer /, "");

  beforeAll(async () => {
    s = await setupApi();
    admin = await login(s.app, "admin@paperboy.test", "Admin!Passw0rd");
    const site = await s.app.inject({ method: "POST", url: "/api/v1/manage/sites", headers: authHeaders(admin), payload: { slug: "brand-b", name: "Brand B", defaultLocale: "en" } });
    siteB = site.json().id as string;
    // A token confined to Brand B: uploads must land there, not in the Default site.
    const minted = await s.app.inject({
      method: "POST",
      url: "/api/v1/manage/mcp-tokens",
      headers: { ...authHeaders(admin), "x-paperboy-site": siteB },
      payload: { name: "uploads" },
    });
    expect(minted.statusCode, minted.body).toBe(200);
    mcp = new McpClient({ DATABASE_URL: TEST_DB, MCP_TOKEN: minted.json().token as string, MCP_HTTP_PORT: "", PUBLIC_URL, UPLOADS_DIR });
    await mcp.initialize();
  }, 120_000);
  afterAll(async () => {
    mcp?.kill();
    await s.app.close();
  });

  it("create_upload_link → curl-able files land in the token's site, as that user", async () => {
    const link = await newLink();
    expect(link.uploadUrl).toBe(`${PUBLIC_URL}/api/v1/uploads`);
    expect(link.example).toContain("curl");

    const res = await upload(tokenOf(link), [
      { name: "hero-s1.jpg", type: "image/jpeg", data: JPEG },
      { name: "hero-s2.png", type: "image/png", data: PNG },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const { assets, rejected } = res.json() as { assets: Array<{ documentId: string; filename: string; mime: string }>; rejected: unknown[] };
    expect(rejected).toEqual([]);
    expect(assets.map((a) => [a.filename, a.mime])).toEqual([["hero-s1.jpg", "image/jpeg"], ["hero-s2.png", "image/png"]]);

    // Visible through the MCP (Brand B) and the bytes are served.
    const listed = await mcp.call("list_assets");
    const ids = (listed.json as Array<{ documentId: string }>).map((a) => a.documentId);
    expect(ids).toEqual(expect.arrayContaining(assets.map((a) => a.documentId)));
    const served = await s.app.inject({ method: "GET", url: `/api/v1/media/${assets[0]!.documentId}.jpg` });
    expect(served.statusCode).toBe(200);
    // …and NOT in the Default site.
    const defaultAssets = await s.app.inject({ method: "GET", url: "/api/v1/manage/assets", headers: authHeaders(admin) });
    expect((defaultAssets.json() as Array<{ documentId: string }>).map((a) => a.documentId)).not.toContain(assets[0]!.documentId);
  }, 60_000);

  it("answers each file on its own: a non-image is rejected by name, the rest is stored", async () => {
    const res = await upload(tokenOf(await newLink()), [
      { name: "ok.png", type: "image/png", data: PNG },
      { name: "notes.txt", type: "image/png", data: Buffer.from("definitely not an image, whatever the header says") },
    ]);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { assets: Array<{ filename: string }>; rejected: Array<{ filename: string; error: string }> };
    expect(body.assets.map((a) => a.filename)).toEqual(["ok.png"]);
    expect(body.rejected).toEqual([{ filename: "notes.txt", error: expect.stringMatching(/PNG, JPEG/) }]);
  }, 60_000);

  it("refuses an unknown or expired token, and never accepts the session cookie instead", async () => {
    expect((await upload("upl_not-a-real-token", [{ name: "a.png", type: "image/png", data: PNG }])).statusCode).toBe(401);
    // A signed-in browser has no ambient authority here.
    const cookieOnly = await upload(null, [{ name: "a.png", type: "image/png", data: PNG }], { cookie: admin.cookie, "x-csrf-token": admin.csrf });
    expect(cookieOnly.statusCode).toBe(401);
    expect(cookieOnly.json().message).toMatch(/create_upload_link/);

    const link = await newLink();
    await s.app.db.update(schemaTables.uploadLink).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await upload(tokenOf(link), [{ name: "a.png", type: "image/png", data: PNG }])).statusCode).toBe(401);
  }, 60_000);

  it("upload_asset takes base64 (a data: URL too) and refuses garbage with a self-teaching error", async () => {
    const ok = await mcp.call("upload_asset", { dataBase64: `data:image/png;base64,${PNG.toString("base64")}`, filename: "inline.png", alt: "A test square" });
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.json).toMatchObject({ filename: "inline.png", mime: "image/png", alt: "A test square" });

    const notImage = await mcp.call("upload_asset", { dataBase64: Buffer.from("hello world, plain text").toString("base64") });
    expect(notImage.isError).toBe(true);
    expect(notImage.text).toMatch(/PNG, JPEG/);

    const neither = await mcp.call("upload_asset", { alt: "x" });
    expect(neither.isError).toBe(true);
    expect(neither.text).toMatch(/exactly one of url or dataBase64/);
  }, 60_000);

  it("upload_asset refuses a URL that points inside the network (SSRF)", async () => {
    const res = await mcp.call("upload_asset", { url: "http://127.0.0.1:8091/api/v1/health" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/public host/);
  }, 60_000);
});

describe("fetchPublicFile", () => {
  // A local server stands in for the internet; the injected guard "vets" it.
  let base: string;
  const vetLocal = async () => ["127.0.0.1"];
  const server = createServer((req, res) => {
    if (req.url === "/photo.png") return void res.writeHead(200, { "content-type": "image/png" }).end(PNG);
    if (req.url === "/moved") return void res.writeHead(302, { location: "/photo.png" }).end();
    if (req.url === "/huge") {
      res.writeHead(200); // no content-length: the cap must hold while streaming
      const chunk = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < 6; i++) res.write(chunk);
      return void res.end();
    }
    res.writeHead(404).end();
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("downloads the file and names it from the URL, following a redirect through the guard", async () => {
    const seen: string[] = [];
    const got = await fetchPublicFile(`${base}/moved`, async (u) => {
      seen.push(u);
      return vetLocal();
    });
    expect(got.buf.equals(PNG)).toBe(true);
    expect(got.filename).toBe("photo.png");
    expect(seen).toEqual([`${base}/moved`, `${base}/photo.png`]); // every hop re-vetted
  });

  it("stops at 5 MB even without a Content-Length", async () => {
    await expect(fetchPublicFile(`${base}/huge`, vetLocal)).rejects.toMatchObject({ status: 413 });
  });

  it("without an injected guard, a loopback URL is refused", async () => {
    await expect(fetchPublicFile(`${base}/moved`)).rejects.toThrow(/public host/);
  });
});
