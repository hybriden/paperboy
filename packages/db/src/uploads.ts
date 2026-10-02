import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { type IncomingMessage, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { sniffUpload } from "@paperboy/shared";
import { and, eq, gt, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { type AssetRecord, MEDIA_PREFIX, insertAsset } from "./assets.js";
import { getAccessContext } from "./auth-store.js";
import type { Database } from "./client.js";
import { AppError, Errors } from "./errors.js";
import { type AccessContext, requirePermission } from "./scope.js";
import { uploadLink } from "./schema.js";
import { assertPublicHttpUrl, pinnedLookup } from "./webhooks.js";

/**
 * Getting bytes into the media library from anywhere but the admin's file
 * picker: an agent's local files (upload links), a URL, or base64. Every path
 * ends in `storeUploadedAsset`, so the sniff, the size cap and the RBAC check
 * are the same ones the admin upload goes through.
 */

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const UNSUPPORTED = "Only PNG, JPEG, GIF, WEBP images or PDF documents are allowed";
const LINK_TTL_MS = 15 * 60_000;

export type SaveUpload = (fileName: string, buf: Buffer) => Promise<{ relativePath: string }>;

/** Write into the uploads dir that /api/v1/media serves (the API and the MCP share the volume). */
export function saveToUploadsDir(uploadsDir: string): SaveUpload {
  return async (fileName, buf) => {
    await mkdir(uploadsDir, { recursive: true });
    await writeFile(join(uploadsDir, fileName), buf); // safe: server-generated name
    return { relativePath: `${MEDIA_PREFIX}/${fileName}` };
  };
}

export const tooLarge = () => new AppError(413, "too_large", "Max file size is 5 MB");

/** Bytes → asset. Rejects anything that isn't a supported image or PDF by its magic bytes. */
export async function storeUploadedAsset(
  db: Database,
  ctx: AccessContext,
  input: { buf: Buffer; filename?: string; alt?: string },
  save: SaveUpload,
): Promise<AssetRecord> {
  requirePermission(ctx, "content.create");
  if (input.buf.length > MAX_UPLOAD_BYTES) throw tooLarge();
  const sniff = sniffUpload(input.buf);
  if (!sniff) throw new AppError(415, "unsupported_media", UNSUPPORTED);
  const documentId = nanoid(24);
  const { relativePath } = await save(`${documentId}.${sniff.ext}`, input.buf); // server-generated name
  return insertAsset(db, ctx, {
    documentId,
    // Display metadata only. Strip control chars + path separators and cap the
    // length, so untrusted text never reaches storage or any consumer (L8).
    filename: (input.filename ?? "").replace(/[\p{Cc}/\\]/gu, "").slice(0, 255) || "file",
    mime: sniff.mime,
    size: input.buf.length,
    relativePath,
    alt: input.alt?.slice(0, 300),
  });
}

/* ------------------------------ upload links ------------------------------ */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Mint a short-lived upload link: whoever holds the token may upload files AS
 * this user, into the active site, until it expires. Reusable within that
 * window, so one link covers a batch.
 */
export async function createUploadLink(db: Database, ctx: AccessContext): Promise<{ token: string; expiresAt: Date }> {
  requirePermission(ctx, "content.create");
  const token = `upl_${randomBytes(32).toString("base64url")}`; // 256-bit
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);
  await db.delete(uploadLink).where(lt(uploadLink.expiresAt, new Date())); // housekeeping
  await db.insert(uploadLink).values({ tokenHash: sha256(token), userId: ctx.userId, siteId: ctx.siteId, expiresAt });
  return { token, expiresAt };
}

/** The access context an upload-link token acts with, re-resolved now (so role changes apply); null if unknown or expired. */
export async function resolveUploadLink(db: Database, token: string): Promise<AccessContext | null> {
  const rows = await db
    .select()
    .from(uploadLink)
    .where(and(eq(uploadLink.tokenHash, sha256(token)), gt(uploadLink.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  return row ? getAccessContext(db, row.userId, row.siteId) : null;
}

/* ------------------------------- URL imports ------------------------------ */

function getPinned(url: string, addresses: string[], signal: AbortSignal): Promise<IncomingMessage> {
  const u = new URL(url);
  const request = u.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(u, { method: "GET", signal, lookup: pinnedLookup(addresses) }, resolve);
    req.on("error", reject);
    req.end();
  });
}

/**
 * Download a caller-supplied URL. Every hop goes through the egress guard and
 * connects to the addresses it vetted (no DNS rebinding); redirects are
 * followed by hand so a public host can't bounce the server to an internal
 * one. The 5 MB cap is enforced as bytes arrive. `assertAllowed` is injectable
 * so tests can reach a local server.
 */
export async function fetchPublicFile(
  url: string,
  assertAllowed: (url: string) => Promise<string[]> = (u) => assertPublicHttpUrl(u, "Image URL"),
): Promise<{ buf: Buffer; filename: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    let current = url;
    for (let hop = 0; hop < 5; hop++) {
      const res = await getPinned(current, await assertAllowed(current), ac.signal);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        const location = res.headers.location;
        if (!location) throw Errors.badRequest(`Downloading ${url} failed: redirect without a location`);
        current = new URL(location, current).toString(); // vetted at the top of the next hop
        continue;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        throw Errors.badRequest(`Downloading ${url} failed (HTTP ${status}) — check that the URL is public and points straight at the file`);
      }
      if (Number(res.headers["content-length"]) > MAX_UPLOAD_BYTES) {
        res.destroy();
        throw tooLarge();
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of res as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > MAX_UPLOAD_BYTES) {
          res.destroy();
          throw tooLarge();
        }
        chunks.push(chunk);
      }
      return { buf: Buffer.concat(chunks), filename: new URL(current).pathname.split("/").pop() ?? "" };
    }
    throw Errors.badRequest(`Downloading ${url} failed: too many redirects`);
  } finally {
    clearTimeout(timer);
  }
}

/** Download a URL into the media library (the MCP `upload_asset` url path). */
export async function importAssetFromUrl(
  db: Database,
  ctx: AccessContext,
  input: { url: string; filename?: string; alt?: string },
  save: SaveUpload,
  fetchFile: (url: string) => Promise<{ buf: Buffer; filename: string }> = fetchPublicFile,
): Promise<AssetRecord> {
  requirePermission(ctx, "content.create"); // before any network traffic
  const file = await fetchFile(input.url);
  return storeUploadedAsset(db, ctx, { buf: file.buf, filename: input.filename ?? file.filename, alt: input.alt }, save);
}
