import { recordExperimentEvents, recordTraffic, verifyDeliveryKey } from "@paperboy/db";
import { EXPERIMENT_ARMS } from "@paperboy/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

/**
 * POST /delivery/traffic — what a frontend saw: the redirect rules it applied
 * (hit counts, "last used") and the paths that answered 404 (the 404 log in
 * Settings → Redirects). A public WRITE, so it follows the form-submission
 * rules: its own module, the delivery key is the ONLY credential (a session
 * cookie is never read), and the key pins the site.
 *
 * Meant to be called server-side by the frontend (a Worker, a Next.js route),
 * never from the browser: the body carries paths only — the query string is
 * stripped before storage, and no IP or user agent is recorded.
 */

const TrafficBody = z.object({
  /** Ids of the rules the frontend applied (one entry per redirect served). */
  redirectHits: z.array(z.number().int().positive()).max(100).optional(),
  /** Request paths that answered 404. */
  notFound: z.array(z.string().max(2000)).max(100).optional(),
  /** A/B versions shown (#125): one entry per page view that rendered a version. */
  exposures: z.array(z.object({ experimentId: z.number().int().positive(), arm: z.enum(EXPERIMENT_ARMS) })).max(100).optional(),
  /** A/B goals reached; `goal` is "form" or "event:<name>" and must be the experiment's own. */
  conversions: z.array(z.object({ experimentId: z.number().int().positive(), arm: z.enum(EXPERIMENT_ARMS), goal: z.string().max(80).optional() })).max(100).optional(),
});

function deliveryKeyOf(req: FastifyRequest): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : "";
}

export async function registerTrafficRoutes(appBase: FastifyInstance): Promise<void> {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  app.post(
    "/traffic",
    {
      config: {
        cors: false,
        // One frontend reports from a few egress IPs, so the bucket is per
        // key, not per IP; the key is a server-side secret of that frontend.
        rateLimit: { max: 600, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => `traffic:${deliveryKeyOf(req).slice(0, 24)}` },
      },
      schema: {
        tags: ["delivery"],
        summary: "Report applied redirects and 404 paths (server-side, public key)",
        body: TrafficBody,
        response: {
          202: z.object({
            hits: z.number(),
            notFound: z.number(),
            /** Unknown, ended or mismatched experiment events are ignored and counted here, never an error. */
            experiments: z.object({ exposures: z.number(), conversions: z.number(), ignored: z.number() }),
          }),
          401: z.object({ error: z.string(), message: z.string() }),
          403: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (req, reply) => {
      // Deliberately NOT req.user: the delivery key is the only credential.
      const resolved = await verifyDeliveryKey(app.db, deliveryKeyOf(req));
      if (!resolved) return reply.code(401).send({ error: "unauthorized", message: "Invalid or missing API key" });
      if (resolved.type !== "public") {
        return reply.code(403).send({ error: "forbidden", message: "Report traffic with the PUBLIC delivery key — preview traffic is editors, not visitors." });
      }
      const counted = await recordTraffic(app.db, resolved.siteId, req.body);
      const experiments = await recordExperimentEvents(app.db, resolved.siteId, req.body);
      return reply.code(202).send({ ...counted, experiments });
    },
  );
}
