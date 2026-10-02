import { type AssetRecord, Errors, audit, resolveUploadLink, saveToUploadsDir, storeUploadedAsset } from "@paperboy/db";
import type { FastifyInstance } from "fastify";

/**
 * Upload-link endpoint: how an agent gets LOCAL files into the media library.
 *
 * A remote MCP server can't read the agent's disk, and base64 through a tool
 * call costs ~100k tokens per image. So the MCP's `create_upload_link` mints a
 * short-lived token and the agent posts its files here with curl:
 *
 *   curl -H "Authorization: Bearer upl_…" -F file=@a.jpg -F file=@b.jpg {PUBLIC_URL}/api/v1/uploads
 *
 * The token is the ONLY credential: this handler never consults the session
 * cookie (so there is no ambient authority for CSRF to ride), and it acts as
 * the user who minted the link, in the site it was minted in, with that user's
 * roles as they are NOW. Files go through the same sniff and size cap as the
 * admin's upload. Each file is answered on its own, so one bad file in a batch
 * doesn't hide which others were stored.
 */

const MAX_FILES = 20;

export async function registerUploadRoutes(app: FastifyInstance, opts: { uploadsDir: string }): Promise<void> {
  const save = saveToUploadsDir(opts.uploadsDir);

  app.post(
    "/api/v1/uploads",
    {
      schema: { tags: ["uploads"], summary: "Upload files with an upload-link token (MCP create_upload_link); multipart/form-data, up to 20 files" },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
      const ctx = token ? await resolveUploadLink(app.db, token) : null;
      if (!ctx) {
        return reply.code(401).send({
          error: "unauthorized",
          message: "Missing, unknown or expired upload link — ask the Paperboy MCP for a new one (create_upload_link) and send it as 'Authorization: Bearer <token>'.",
        });
      }
      // Roles are re-resolved per request: a link outlives no demotion.
      if (!ctx.permissions.includes("content.create")) throw Errors.forbidden("This upload link's user may no longer upload files");
      if (!req.isMultipart()) {
        return reply.code(400).send({ error: "bad_request", message: "Send multipart/form-data with one or more file fields, e.g. curl -F file=@photo.jpg" });
      }

      const assets: AssetRecord[] = [];
      const rejected: Array<{ filename: string; error: string }> = [];
      for await (const part of req.files({ limits: { files: MAX_FILES } })) {
        const filename = part.filename ?? "";
        try {
          const buf = await part.toBuffer();
          const rec = await storeUploadedAsset(app.db, ctx, { buf, filename }, save);
          await audit(app.db, {
            actorUserId: ctx.userId,
            action: "asset.upload",
            documentId: rec.documentId,
            ip: req.ip,
            detail: { mime: rec.mime, size: rec.size, via: "upload-link" },
          });
          assets.push(rec);
        } catch (err) {
          const tooBig = (err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE";
          rejected.push({ filename, error: tooBig ? "Max file size is 5 MB" : (err as Error).message });
        }
      }
      if (!assets.length && !rejected.length) {
        return reply.code(400).send({ error: "bad_request", message: "No file uploaded — send one or more file fields, e.g. curl -F file=@photo.jpg" });
      }
      return reply.code(rejected.length ? 422 : 200).send({ assets, rejected });
    },
  );
}
