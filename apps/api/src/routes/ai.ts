import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { AI_TASKS, aiAssist, aiTranslateBatch } from "@paperboy/shared";
import { getStoredAiKey, getStoredAiModel } from "@paperboy/db";
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
        }),
        response: { 200: z.object({ result: z.string(), provider: z.enum(["anthropic", "fallback"]) }) },
      },
    },
    async (req) => aiAssist(req.body, await resolveAiConfig()),
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
          { db: app.db, ctx: req.accessCtx!, cfg, emit: send },
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
