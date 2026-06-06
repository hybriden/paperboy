import { createReadStream } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { z } from "zod";

/**
 * Media serving with on-the-fly image transforms:
 *
 *   GET /api/v1/media/<file>?w=800&format=webp&q=75
 *
 * Variants are generated once with sharp and cached on disk under
 * `<uploads>/_variants/`, then served like any static file. Width and quality
 * SNAP to fixed steps so the variant space is bounded (no disk-fill via
 * ?w=1..2000). Requests without transform params (and non-transformable types:
 * gif — animation — and pdf) stream the original.
 *
 * This `:file` param route wins over @fastify/static's wildcard for
 * single-segment paths, so it is the primary media server; the param regex
 * (no slashes, no dots beyond the extension) makes traversal impossible.
 */

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  pdf: "application/pdf",
};

// Bounded variant space: widths/qualities snap UP to the nearest step.
const WIDTHS = [64, 128, 256, 320, 480, 640, 768, 1024, 1280, 1600, 2000];
const QUALITIES = [50, 60, 75, 85, 90];
const TRANSFORMABLE = new Set(["png", "jpg", "jpeg", "webp"]);

function snapUp(value: number, allowed: number[]): number {
  return allowed.find((a) => a >= value) ?? allowed[allowed.length - 1]!;
}

function serveFile(reply: FastifyReply, path: string, mime: string, size: number): FastifyReply {
  reply.header("Content-Type", mime);
  reply.header("Content-Length", String(size));
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Cache-Control", "public, max-age=31536000, immutable");
  return reply.send(createReadStream(path));
}

export async function registerMediaRoutes(appBase: FastifyInstance): Promise<void> {
  const app = appBase.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/v1/media/:file",
    {
      // Transforms are CPU work — tighter than the static path, looser than writes.
      config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
      schema: {
        tags: ["delivery"],
        params: z.object({
          // Server-generated names only: nanoid + single extension. No dots/slashes elsewhere.
          file: z.string().regex(/^[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp|avif|pdf)$/i),
        }),
        querystring: z.object({
          /** Target width in px (snaps up to a fixed step; never enlarges). */
          w: z.coerce.number().int().min(1).max(4000).optional(),
          format: z.enum(["webp", "avif", "jpeg", "png"]).optional(),
          /** Quality 1–100 (snaps to a fixed step). */
          q: z.coerce.number().int().min(1).max(100).optional(),
        }),
      },
    },
    async (req, reply) => {
      const file = req.params.file;
      const ext = file.split(".").pop()!.toLowerCase();
      const originalPath = join(app.uploadsDir, file);
      const original = await stat(originalPath).catch(() => null);
      if (!original?.isFile()) return reply.code(404).send({ error: "not_found", message: "No such file" });

      const wantsTransform = (req.query.w != null || req.query.format != null || req.query.q != null) && TRANSFORMABLE.has(ext);
      if (!wantsTransform) {
        return serveFile(reply, originalPath, MIME[ext] ?? "application/octet-stream", original.size);
      }

      const width = req.query.w != null ? snapUp(Math.max(16, req.query.w), WIDTHS) : null;
      const quality = snapUp(req.query.q ?? 75, QUALITIES);
      const format = req.query.format ?? (ext === "jpg" ? "jpeg" : (ext as "jpeg" | "png" | "webp"));
      const variantName = `${file}.w${width ?? "orig"}q${quality}.${format === "jpeg" ? "jpg" : format}`;
      const variantsDir = join(app.uploadsDir, "_variants");
      const variantPath = join(variantsDir, variantName);

      let variant = await stat(variantPath).catch(() => null);
      if (!variant) {
        await mkdir(variantsDir, { recursive: true });
        let img = sharp(originalPath, { failOn: "none" });
        if (width) img = img.resize({ width, withoutEnlargement: true });
        if (format === "webp") img = img.webp({ quality });
        else if (format === "avif") img = img.avif({ quality });
        else if (format === "jpeg") img = img.flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true });
        else img = img.png();
        const buf = await img.toBuffer().catch(() => null);
        if (!buf) {
          // Undecodable source (e.g. a corrupt upload): fall back to the original bytes.
          return serveFile(reply, originalPath, MIME[ext] ?? "application/octet-stream", original.size);
        }
        // Write-then-rename: concurrent requests never see a half-written variant.
        const tmp = `${variantPath}.${nanoid(6)}.tmp`;
        await writeFile(tmp, buf);
        await rename(tmp, variantPath).catch(() => undefined); // lost race = another request already wrote it
        variant = await stat(variantPath);
      }
      return serveFile(reply, variantPath, MIME[format === "jpeg" ? "jpg" : format]!, variant.size);
    },
  );
}
