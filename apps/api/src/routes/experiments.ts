import {
  audit,
  createExperiment,
  endExperiment,
  getExperiment,
  getExperimentSettings,
  listExperiments,
  pauseExperiment,
  setExperimentSettings,
  startExperiment,
  updateExperiment,
} from "@paperboy/db";
import { EXPERIMENT_ARMS, EXPERIMENT_MODES, EXPERIMENT_STATUSES } from "@paperboy/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth, requireCsrf, requirePermission } from "../security.js";

/**
 * A/B experiments (#125) for the ACTIVE site. Reading needs content.read,
 * preparing a draft content.update (section-scoped, so an Author can), and
 * starting, pausing and ending content.publish. The rules live in
 * packages/db/src/experiments.ts; the counting is POST /delivery/traffic.
 */

const Comparison = z.object({ lift: z.number().nullable(), diffLow: z.number(), diffHigh: z.number(), pValue: z.number() });
const ExperimentOut = z.object({
  id: z.number(),
  documentId: z.string(),
  locale: z.string(),
  area: z.string(),
  pageName: z.string().nullable(),
  name: z.string(),
  hypothesis: z.string().nullable(),
  status: z.enum(EXPERIMENT_STATUSES),
  goal: z.string(),
  baselineRate: z.number().nullable(),
  mde: z.number().nullable(),
  endsAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  endReason: z.string().nullable(),
  winner: z.string().nullable(),
  needsReview: z.boolean(),
  createdVia: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  arms: z.array(z.object({ key: z.string(), label: z.string().nullable(), weight: z.number(), blocks: z.array(z.unknown()).nullable() })),
  results: z.array(z.object({ key: z.string(), exposures: z.number(), conversions: z.number(), rate: z.number().nullable(), comparison: Comparison.nullable() })),
  verdict: z.object({ summary: z.string(), complete: z.boolean(), leader: z.string().nullable(), srmWarning: z.boolean(), needed: z.number().nullable() }),
  estimate: z.object({ perDay: z.number().nullable(), daysLeft: z.number().nullable() }),
});
const ExperimentDetail = ExperimentOut.extend({ daily: z.array(z.object({ day: z.string(), arm: z.string(), exposures: z.number(), conversions: z.number() })) });

const ArmIn = z.object({
  key: z.enum(EXPERIMENT_ARMS).optional(),
  label: z.string().max(120).nullable().optional(),
  weight: z.number().int().min(0).max(100).optional(),
  blocks: z.array(z.unknown()).max(200).optional(),
});
const Plan = {
  name: z.string().min(1).max(200),
  hypothesis: z.string().max(2000).nullable().optional(),
  goal: z.string().max(80).optional(),
  baselineRate: z.number().nullable().optional(),
  mde: z.number().nullable().optional(),
  endsAt: z.string().max(40).nullable().optional(),
  arms: z.array(ArmIn).min(1).max(4),
};
const CreateBody = z.object({ documentId: z.string().max(64), locale: z.string().max(35), area: z.string().max(100), ...Plan });
const UpdateBody = z.object(Plan).partial();
const IdParams = z.object({ id: z.coerce.number().int().positive() });
const Settings = z.object({ mode: z.enum(EXPERIMENT_MODES), warnDays: z.number(), overdue: z.array(z.number()) });

export async function registerExperimentRoutes(appBase: FastifyInstance): Promise<void> {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", requireAuth);
  const log = (req: FastifyRequest, action: string, e: { id: number; documentId: string; locale: string; name?: string }, detail: Record<string, unknown> = {}) =>
    audit(app.db, { siteId: req.accessCtx?.siteId, actorUserId: req.user!.id, action, documentId: e.documentId, locale: e.locale, ip: req.ip, detail: { id: e.id, name: e.name, ...detail } });

  app.get(
    "/experiments",
    {
      preHandler: [requirePermission("content.read")],
      schema: {
        tags: ["manage"],
        summary: "List A/B experiments (active site)",
        querystring: z.object({ status: z.enum(EXPERIMENT_STATUSES).optional(), documentId: z.string().max(64).optional() }),
        response: { 200: z.array(ExperimentOut) },
      },
    },
    async (req) => listExperiments(app.db, req.accessCtx!, req.query),
  );

  app.get(
    "/experiments/settings",
    { preHandler: [requirePermission("content.read")], schema: { tags: ["manage"], summary: "A/B privacy mode and run-length warning (active site)", response: { 200: Settings } } },
    async (req) => getExperimentSettings(app.db, req.accessCtx!),
  );

  app.put(
    "/experiments/settings",
    {
      preHandler: [requireCsrf, requirePermission("site.manage")],
      schema: { tags: ["manage"], summary: "Set the A/B privacy mode and run-length warning", body: z.object({ mode: z.enum(EXPERIMENT_MODES).optional(), warnDays: z.number().int().optional() }), response: { 200: Settings } },
    },
    async (req) => {
      const out = await setExperimentSettings(app.db, req.accessCtx!, req.body);
      await audit(app.db, { siteId: req.accessCtx?.siteId, actorUserId: req.user!.id, action: "experiment.settings", ip: req.ip, detail: req.body });
      return out;
    },
  );

  app.get(
    "/experiments/:id",
    { preHandler: [requirePermission("content.read")], schema: { tags: ["manage"], summary: "One experiment with its results", params: IdParams, response: { 200: ExperimentDetail } } },
    async (req) => getExperiment(app.db, req.accessCtx!, req.params.id),
  );

  app.post(
    "/experiments",
    { preHandler: [requireCsrf, requirePermission("content.update")], schema: { tags: ["manage"], summary: "Create an experiment (draft) on a page's content area", body: CreateBody, response: { 200: ExperimentOut } } },
    async (req) => {
      const out = await createExperiment(app.db, req.accessCtx!, req.body);
      await log(req, "experiment.create", out, { area: out.area, versions: out.arms.length });
      return out;
    },
  );

  app.patch(
    "/experiments/:id",
    { preHandler: [requireCsrf, requirePermission("content.update")], schema: { tags: ["manage"], summary: "Edit a draft or paused experiment", params: IdParams, body: UpdateBody, response: { 200: ExperimentOut } } },
    async (req) => {
      const out = await updateExperiment(app.db, req.accessCtx!, req.params.id, req.body);
      await log(req, "experiment.update", out);
      return out;
    },
  );

  app.post(
    "/experiments/:id/start",
    { preHandler: [requireCsrf, requirePermission("content.publish")], schema: { tags: ["manage"], summary: "Start (or resume) an experiment", params: IdParams, response: { 200: ExperimentOut } } },
    async (req) => {
      const out = await startExperiment(app.db, req.accessCtx!, req.params.id);
      await log(req, "experiment.start", out);
      return out;
    },
  );

  app.post(
    "/experiments/:id/pause",
    { preHandler: [requireCsrf, requirePermission("content.publish")], schema: { tags: ["manage"], summary: "Pause a running experiment (visitors see version A)", params: IdParams, response: { 200: ExperimentOut } } },
    async (req) => {
      const out = await pauseExperiment(app.db, req.accessCtx!, req.params.id);
      await log(req, "experiment.pause", out);
      return out;
    },
  );

  app.post(
    "/experiments/:id/end",
    {
      preHandler: [requireCsrf, requirePermission("content.publish")],
      schema: {
        tags: ["manage"],
        summary: "End an experiment, optionally applying the winner as a draft or publishing it",
        params: IdParams,
        body: z.object({ winner: z.enum(EXPERIMENT_ARMS).nullable().optional(), apply: z.enum(["draft", "publish", "none"]).optional() }),
        response: { 200: z.object({ experiment: ExperimentOut, applied: z.enum(["draft", "publish", "none"]) }) },
      },
    },
    async (req) => {
      const out = await endExperiment(app.db, req.accessCtx!, req.params.id, req.body);
      await log(req, "experiment.end", out.experiment, { winner: out.experiment.winner, applied: out.applied });
      return out;
    },
  );
}
