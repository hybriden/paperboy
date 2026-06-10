import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import sharp from "sharp";
import { z } from "zod";
import { AI_TASKS, AiUnavailableError, aiAssist, aiImageAltText, aiTranslateBatch } from "@paperboy/shared";
import { getAssetRow, getStoredAiKey, getStoredAiModel } from "@paperboy/db";
import { runContentAgent } from "../agent.js";
import { requireAuth, requireCsrf, requirePermission } from "../security.js";

/**
 * AI editorial assistant. One endpoint, several editor-facing tasks (SEO title/
 * description, summarise, improve, alt text, translate). Authenticated +
 * CSRF-protected + rate-limited; requires content.update (an editing verb).
 */
export async function registerAiRoutes(appBase: FastifyInstance): Promise<void> {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", requireAuth);

  // Resolve the provider config at request time: a key/model set in the CMS
  // (Settings → Site) overrides the ANTHROPIC_API_KEY/AI_MODEL env fallback, so
  // it can be changed without restarting the api.
  async function resolveAiConfig(): Promise<{ apiKey?: string; model: string }> {
    const apiKey = (await getStoredAiKey(app.db)) ?? app.aiConfig.apiKey;
    const model = (await getStoredAiModel(app.db)) ?? app.aiConfig.model;
    return { apiKey, model };
  }

  app.get(
    "/status",
    { schema: { tags: ["ai"], response: { 200: z.object({ enabled: z.boolean(), tasks: z.array(z.string()) }) } } },
    async () => ({ enabled: Boolean((await resolveAiConfig()).apiKey), tasks: [...AI_TASKS] }),
  );

  app.post(
    "/assist",
    {
      preHandler: [requireCsrf, requirePermission("content.update")],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["ai"],
        body: z.object({
          task: z.enum(AI_TASKS),
          input: z.string().min(1).max(20_000),
          targetLocale: z.string().max(40).optional(),
          instruction: z.string().max(500).optional(),
          context: z.string().max(4000).optional(),
        }),
        response: {
          200: z.object({ result: z.string(), provider: z.enum(["anthropic", "fallback"]) }),
          409: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (req, reply) => {
      try {
        return await aiAssist(req.body, await resolveAiConfig());
      } catch (err) {
        if (err instanceof AiUnavailableError) return reply.code(409).send({ error: "ai_unavailable", message: err.message });
        throw err;
      }
    },
  );

  // Alt text from the ACTUAL IMAGE (vision) — never from the filename. The
  // asset is loaded site-partitioned, downscaled server-side, and sent to the
  // model as an image content block. Requires a configured key (409 without).
  app.post(
    "/alt-text",
    {
      preHandler: [requireCsrf, requirePermission("content.update")],
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["ai"],
        body: z.object({ documentId: z.string().min(1).max(64) }),
        response: {
          200: z.object({ result: z.string(), provider: z.enum(["anthropic", "fallback"]) }),
          400: z.object({ error: z.string(), message: z.string() }),
          404: z.object({ error: z.string(), message: z.string() }),
          409: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const cfg = await resolveAiConfig();
      if (!cfg.apiKey) {
        return reply.code(409).send({ error: "ai_unavailable", message: new AiUnavailableError().message });
      }
      const row = await getAssetRow(app.db, req.body.documentId, req.accessCtx!.siteId);
      if (!row) return reply.code(404).send({ error: "not_found", message: "Asset not found" });
      if (!row.mime.startsWith("image/") || row.mime === "image/svg+xml") {
        return reply.code(400).send({ error: "not_an_image", message: `Alt text needs a raster image; this asset is ${row.mime}.` });
      }
      // basename() guards against a hostile url value; files are stored flat
      // under uploadsDir with server-generated names.
      const file = await readFile(join(app.uploadsDir, basename(row.url)));
      // Downscale before sending: vision quality saturates well below original
      // resolution, and request size/cost scale with pixels.
      const small = await sharp(file).resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      try {
        return await aiImageAltText(
          { imageBase64: small.toString("base64"), mediaType: "image/jpeg", filename: row.filename },
          cfg,
        );
      } catch (err) {
        if (err instanceof AiUnavailableError) return reply.code(409).send({ error: "ai_unavailable", message: err.message });
        throw err;
      }
    },
  );

  // Batch translation — a whole page's text fields in ONE request (instead of one
  // /assist call per field, which trips the rate limit on large pages).
  app.post(
    "/translate",
    {
      preHandler: [requireCsrf, requirePermission("content.update")],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["ai"],
        body: z.object({
          texts: z.array(z.string().max(20_000)).max(100),
          targetLocale: z.string().min(1).max(40),
        }),
        response: { 200: z.object({ results: z.array(z.string()), provider: z.enum(["anthropic", "fallback"]) }) },
      },
    },
    async (req) => aiTranslateBatch(req.body.texts, req.body.targetLocale, await resolveAiConfig()),
  );

  // The content agent ("Build from brief"): a server-side tool-use loop that
  // creates DRAFTS as the signed-in user (its tool registry has no publish/
  // delete tools — structural guardrail, see agent.ts). Streams progress as
  // Server-Sent Events so the editor watches the work happen.
  app.post(
    "/agent",
    {
      preHandler: [requireCsrf, requirePermission("content.create")],
      config: { rateLimit: { max: 5, timeWindow: "5 minutes" } },
      schema: {
        tags: ["ai"],
        body: z.object({
          brief: z.string().min(10).max(4000),
          parentId: z.string().nullable().optional(),
          locale: z.string().max(40).default("en"),
        }),
      },
    },
    async (req, reply) => {
      const cfg = await resolveAiConfig();
      if (!cfg.apiKey) {
        return reply.code(409).send({ error: "AI provider is not configured (Settings → Site → AI key)." });
      }
      // SSE: take over the raw socket. X-Accel-Buffering disables proxy
      // buffering (nginx) so events arrive as they happen.
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const send = (ev: unknown) => reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      try {
        await runContentAgent(
          // via:"agent" — drafts the brief-builder writes are agent provenance:
          // versions record created_via='agent' and carry the needs-review flag.
          { db: app.db, ctx: { ...req.accessCtx!, via: "agent" }, cfg, emit: send },
          req.body.brief,
          { parentId: req.body.parentId ?? null, locale: req.body.locale },
        );
      } catch (err) {
        send({ type: "error", text: err instanceof Error ? err.message : "Agent failed" });
      } finally {
        reply.raw.end();
      }
    },
  );
}
