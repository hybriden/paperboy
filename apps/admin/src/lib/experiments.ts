import { requiredSampleSize } from "@paperboy/shared";
import type { ExperimentView } from "./api.js";

/**
 * Small, pure helpers the experiment UI shares (#125). Words: an experiment has
 * VERSIONS A–D; "variant" means a language branch here, never this.
 */

/** The experiment an area shows: the live (running/paused) one, else the newest draft. */
export function experimentFor(list: ExperimentView[], area: string, locale: string): ExperimentView | undefined {
  const own = list.filter((e) => e.area === area && e.locale === locale && e.status !== "ended");
  return own.find((e) => e.status === "running" || e.status === "paused") ?? own[0];
}

/** "Experiment running · B leads · not conclusive": the area badge. */
export function experimentBadge(e: ExperimentView): string {
  const parts = [`Experiment ${e.status}`];
  if (e.status === "running" || e.status === "paused") {
    if (e.verdict.leader) parts.push(`${e.verdict.leader.toUpperCase()} leads`);
    parts.push(e.verdict.complete ? "conclusive" : "not conclusive");
  }
  return parts.join(" · ");
}

export const versionName = (key: string): string => `Version ${key.toUpperCase()}`;

/** 0.0412 → "4.1 %"; null → "—". */
export function pct(rate: number | null, digits = 1): string {
  return rate == null ? "—" : `${(rate * 100).toFixed(digits)} %`;
}

/** Relative lift with the 95 % interval of the absolute difference, in points. */
export function liftText(c: { lift: number | null; diffLow: number; diffHigh: number } | null): string {
  if (!c) return "—";
  const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "");
  const pts = (n: number) => `${sign(n)}${Math.abs(n * 100).toFixed(1)}`;
  const lift = c.lift == null ? "n/a" : `${sign(c.lift)}${Math.abs(c.lift * 100).toFixed(1)} %`;
  return `${lift} (95 % interval ${pts(c.diffLow)} to ${pts(c.diffHigh)} pts)`;
}

/** Visitors needed per version from percentages typed in the panel; null without a full plan. */
export function neededPerVersion(baselinePct: string, liftPct: string): number | null {
  const b = Number(baselinePct) / 100;
  const l = Number(liftPct) / 100;
  return baselinePct.trim() && liftPct.trim() ? requiredSampleSize(b, l) : null;
}

/** "form" | "event:signup" → the two goal kinds the panel offers. */
export function parseGoal(goal: string): { kind: "form" | "event"; event: string } {
  return goal.startsWith("event:") ? { kind: "event", event: goal.slice(6) } : { kind: "form", event: "" };
}

/** The `pbab` preview parameter that forces one version: "<experimentId>:<arm>". */
export const pbabParam = (id: number, arm: string): string => `&pbab=${encodeURIComponent(`${id}:${arm}`)}`;
