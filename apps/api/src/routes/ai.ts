import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { AI_TASKS, aiAssist } from "@paperboy/shared";
import { requireAuth, requireCsrf, requirePermission } from "../security.js";

/**
 * AI editorial assistant. One endpoint, several editor-facing tasks (SEO title/
 * description, summarise, improve, alt text, translate). Authenticated +
 * CSRF-protected + rate-limited; requires content.update (an editing verb).
 */
export async function registerAiRoutes(appBase: FastifyInstance): Promise<void> {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", requireAuth);

  app.get(
    "/status",
    { schema: { tags: ["ai"], response: { 200: z.object({ enabled: z.boolean(), tasks: z.array(z.string()) }) } } },
    async () => ({ enabled: Boolean(app.aiConfig.apiKey), tasks: [...AI_TASKS] }),
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
    async (req) => aiAssist(req.body, app.aiConfig),
  );
}
