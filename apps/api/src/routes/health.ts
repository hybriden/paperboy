import { ping } from "@paperboy/db";
import type { FastifyInstance } from "fastify";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ status: "ok", service: "paperboy-api" }));

  app.get("/health/ready", async (_req, reply) => {
    try {
      await ping(app.db);
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });
}
