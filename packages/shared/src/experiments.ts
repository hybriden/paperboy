import { z } from "zod";

/**
 * A/B experiments (#125, docs/plans/2026-10-22-ab-testing.md): the pure parts
 * every surface shares — assignment, which `@paperboycms/client` repeats byte
 * for byte (client-experiments.test.ts pins them together), and the statistics
 * the admin and MCP report.
 *
 * Words: an experiment has VERSIONS ("arms" in code) A–D. A is the control,
 * the page's own published area. "Variant" means a language branch here.
 */

export const EXPERIMENT_ARMS = ["a", "b", "c", "d"] as const;
export type ExperimentArmKey = (typeof EXPERIMENT_ARMS)[number];
export const EXPERIMENT_STATUSES = ["draft", "running", "paused", "ended"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
/** cookieless: a version per page view, nothing stored on the device (default).
 *  consent: a first-party visitor id after consent, sticky across pages. */
export const EXPERIMENT_MODES = ["cookieless", "consent"] as const;
export type ExperimentMode = (typeof EXPERIMENT_MODES)[number];
/** What counts as a conversion: a form on the page, or a named event the frontend reports. */
export const EXPERIMENT_GOAL = /^(form|event:[a-z0-9_.-]{1,64})$/;

/** One experiment as delivery ships it on a page. Version A carries no blocks: it is the area itself. */
export const DeliveryExperiment = z.object({
  id: z.number(),
  /** The content area under test. */
  area: z.string(),
  goal: z.string(),
  /** Preview only (drafts and paused experiments are shipped there so the admin can show any version). */
  status: z.enum(EXPERIMENT_STATUSES).optional(),
  arms: z.array(
    z.object({
      key: z.enum(EXPERIMENT_ARMS),
      weight: z.number(),
      /** Delivered blocks (sanitized like the area); absent on A. */
      blocks: z.array(z.unknown()).optional(),
    }),
  ),
});
export type DeliveryExperiment = z.infer<typeof DeliveryExperiment>;

/** 32-bit FNV-1a over UTF-16 code units — the same hash GrowthBook uses. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The version a visitor sees: deterministic for (experiment, visitor), so a
 * returning visitor in consent mode keeps theirs. No visitor key (cookieless
 * mode without one, robots) → the control, so search engines always see A.
 */
export function assignArm(experimentId: number | string, visitorKey: string | null | undefined, arms: ReadonlyArray<{ key: string; weight: number }>): string {
  const control = arms.find((a) => a.key === "a")?.key ?? arms[0]?.key ?? "a";
  const total = arms.reduce((s, a) => s + Math.max(0, a.weight), 0);
  if (!visitorKey || total <= 0) return control;
  const bucket = (fnv1a(`${experimentId}:${visitorKey}`) % 10_000) / 10_000;
  let edge = 0;
  for (const a of arms) {
    edge += Math.max(0, a.weight) / total;
    if (bucket < edge) return a.key;
  }
  return arms[arms.length - 1]!.key;
}

/* ------------------------------- statistics ------------------------------- */

/** erf, Abramowitz–Stegun 7.1.26 (|error| < 1.5e-7). */
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const normalCdf = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2));

/**
 * Visitors needed PER VERSION to detect a relative lift `mde` on a baseline
 * conversion rate `p` (80 % power, 5 % two-sided): n ≈ 16·p(1−p)/δ², δ = p·mde.
 */
export function requiredSampleSize(baselineRate: number, mde: number): number | null {
  if (!(baselineRate > 0 && baselineRate < 1) || !(mde > 0)) return null;
  const delta = baselineRate * mde;
  // Rounded first so float noise (1600.0000000000002) doesn't add a visitor.
  return Math.ceil(Number(((16 * baselineRate * (1 - baselineRate)) / (delta * delta)).toFixed(6)));
}

export interface ArmComparison {
  /** B's rate minus A's, as a fraction of A's (0.12 = +12 %). Null without A conversions. */
  lift: number | null;
  /** 95 % interval of the absolute difference in rates. */
  diffLow: number;
  diffHigh: number;
  pValue: number;
}

/** Two-proportion z-test of a version against the control. */
export function compareToControl(control: { exposures: number; conversions: number }, arm: { exposures: number; conversions: number }): ArmComparison | null {
  if (control.exposures <= 0 || arm.exposures <= 0) return null;
  const pa = control.conversions / control.exposures;
  const pb = arm.conversions / arm.exposures;
  const pooled = (control.conversions + arm.conversions) / (control.exposures + arm.exposures);
  const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / control.exposures + 1 / arm.exposures));
  const z = sePooled > 0 ? (pb - pa) / sePooled : 0;
  const se = Math.sqrt((pa * (1 - pa)) / control.exposures + (pb * (1 - pb)) / arm.exposures);
  return {
    lift: pa > 0 ? (pb - pa) / pa : null,
    diffLow: pb - pa - 1.96 * se,
    diffHigh: pb - pa + 1.96 * se,
    pValue: sePooled > 0 ? 2 * (1 - normalCdf(Math.abs(z))) : 1,
  };
}

/**
 * Sample ratio mismatch: the χ² p-value of the observed exposures against the
 * configured split. Below 0.001 the split is broken (a caching layer pinning
 * one version, a bot) and the results can't be trusted.
 */
export function sampleRatioPValue(observed: number[], weights: number[]): number {
  const n = observed.reduce((s, x) => s + x, 0);
  const w = weights.reduce((s, x) => s + x, 0);
  if (n === 0 || w <= 0 || observed.length < 2) return 1;
  let chi2 = 0;
  observed.forEach((o, i) => {
    const e = (n * weights[i]!) / w;
    if (e > 0) chi2 += ((o - e) * (o - e)) / e;
  });
  // χ² survival function for 1–3 degrees of freedom (2–4 versions), in closed form.
  const df = observed.length - 1;
  const x = chi2;
  if (df === 1) return 1 - erf(Math.sqrt(x / 2));
  if (df === 2) return Math.exp(-x / 2);
  return 1 - erf(Math.sqrt(x / 2)) + Math.sqrt((2 * x) / Math.PI) * Math.exp(-x / 2);
}

export interface ArmResult {
  key: string;
  exposures: number;
  conversions: number;
  rate: number | null;
  comparison: ArmComparison | null;
}

export interface ExperimentVerdict {
  /** Plain-language status, safe to show as is. */
  summary: string;
  /** Versions reached the planned sample size. */
  complete: boolean;
  /** The version that beat the control significantly, only once complete. */
  leader: string | null;
  srmWarning: boolean;
  /** Exposures needed per version, when the plan gave a baseline and a lift. */
  needed: number | null;
}

/**
 * The verdict an editor (or an agent) reads. Never names a winner before every
 * version has reached the planned sample size: stopping at the first
 * significant-looking result ("peeking") multiplies false winners.
 */
export function experimentVerdict(
  arms: ReadonlyArray<{ key: string; weight: number; exposures: number; conversions: number }>,
  plan: { baselineRate?: number | null; mde?: number | null },
): { verdict: ExperimentVerdict; results: ArmResult[] } {
  const control = arms.find((a) => a.key === "a") ?? arms[0];
  const results: ArmResult[] = arms.map((a) => ({
    key: a.key,
    exposures: a.exposures,
    conversions: a.conversions,
    rate: a.exposures > 0 ? a.conversions / a.exposures : null,
    comparison: control && a.key !== control.key ? compareToControl(control, a) : null,
  }));
  const needed = requiredSampleSize(plan.baselineRate ?? 0, plan.mde ?? 0);
  const fewest = Math.min(...arms.map((a) => a.exposures));
  const srmWarning = sampleRatioPValue(arms.map((a) => a.exposures), arms.map((a) => a.weight)) < 0.001;
  const total = arms.reduce((s, a) => s + a.exposures, 0);
  if (total === 0) {
    return { verdict: { summary: "No visitors counted yet.", complete: false, leader: null, srmWarning: false, needed }, results };
  }
  if (needed == null) {
    return {
      verdict: { summary: "No sample size planned: set today's conversion rate and the lift to detect before reading a winner.", complete: false, leader: null, srmWarning, needed },
      results,
    };
  }
  if (fewest < needed) {
    return { verdict: { summary: `Not conclusive yet: ${fewest} of ${needed} visitors per version.`, complete: false, leader: null, srmWarning, needed }, results };
  }
  if (srmWarning) {
    return {
      verdict: { summary: "The split between versions doesn't match the weights (sample ratio mismatch), so no result can be trusted. Look for caching or bots pinning one version.", complete: true, leader: null, srmWarning, needed },
      results,
    };
  }
  const winners = results.filter((r) => r.comparison && r.comparison.pValue < 0.05 && r.comparison.diffLow > 0).sort((x, y) => (y.rate ?? 0) - (x.rate ?? 0));
  const losersOnly = results.every((r) => !r.comparison || r.comparison.diffHigh < 0 || r.comparison.pValue >= 0.05);
  const leader = winners[0]?.key ?? null;
  const summary = leader
    ? `Version ${leader.toUpperCase()} converts better than A (p = ${winners[0]!.comparison!.pValue.toFixed(3)}).`
    : losersOnly && results.some((r) => r.comparison && r.comparison.pValue < 0.05)
      ? "A converts better than the alternatives."
      : "No significant difference at the planned sample size.";
  return { verdict: { summary, complete: true, leader, srmWarning, needed }, results };
}
