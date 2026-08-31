import { ping } from "@paperboy/db";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

export async function registerHealthRoutes(appBase: FastifyInstance): Promise<void> {
  const app = appBase.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/health",
    { schema: { tags: ["health"], summary: "Liveness", response: { 200: z.object({ status: z.literal("ok"), service: z.literal("paperboy-api") }) } } },
    async () => ({ status: "ok" as const, service: "paperboy-api" as const }),
  );

  app.get(
    "/health/ready",
    {
      schema: {
        tags: ["health"],
        summary: "Readiness (database reachable)",
        response: { 200: z.object({ status: z.literal("ready") }), 503: z.object({ status: z.literal("not_ready") }) },
      },
    },
    async (_req, reply) => {
      try {
        await ping(app.db);
        return { status: "ready" as const };
      } catch {
        return reply.code(503).send({ status: "not_ready" as const });
      }
    },
  );
}
