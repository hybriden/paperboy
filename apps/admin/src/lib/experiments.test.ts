import { describe, expect, it } from "vitest";
import type { ExperimentView } from "./api.js";
import { experimentBadge, experimentFor, liftText, neededPerVersion, parseGoal, pbabParam } from "./experiments.js";

const exp = (over: Partial<ExperimentView>): ExperimentView => ({
  id: 1, documentId: "d", locale: "en", area: "mainArea", pageName: null, name: "x", hypothesis: null, status: "draft", goal: "form",
  baselineRate: null, mde: null, endsAt: null, startedAt: null, endedAt: null, endReason: null, winner: null, needsReview: false,
  createdVia: "web", createdAt: "", updatedAt: "", arms: [], results: [],
  verdict: { summary: "", complete: false, leader: null, srmWarning: false, needed: null }, estimate: { perDay: null, daysLeft: null }, ...over,
});

describe("experiment helpers", () => {
  it("picks the live experiment of an area over a draft, and ignores ended ones and other locales", () => {
    const list = [exp({ id: 1, status: "ended" }), exp({ id: 2 }), exp({ id: 3, status: "paused" }), exp({ id: 4, status: "running", locale: "nb" })];
    expect(experimentFor(list, "mainArea", "en")?.id).toBe(3);
    expect(experimentFor(list, "other", "en")).toBeUndefined();
  });

  it("says running, leader and conclusiveness in the badge", () => {
    expect(experimentBadge(exp({ status: "running" }))).toBe("Experiment running · not conclusive");
    expect(experimentBadge(exp({ status: "running", verdict: { summary: "", complete: true, leader: "b", srmWarning: false, needed: 1 } }))).toBe("Experiment running · B leads · conclusive");
    expect(experimentBadge(exp({}))).toBe("Experiment draft");
  });

  it("writes lift with its interval in points", () => {
    expect(liftText({ lift: 0.125, diffLow: -0.012, diffHigh: 0.045 })).toBe("+12.5 % (95 % interval −1.2 to +4.5 pts)");
    expect(liftText({ lift: null, diffLow: 0, diffHigh: 0.1 })).toBe("n/a (95 % interval 0.0 to +10.0 pts)");
    expect(liftText(null)).toBe("—");
  });

  it("computes the sample size only from a full plan", () => {
    expect(neededPerVersion("50", "100")).toBe(16);
    expect(neededPerVersion("4", "")).toBeNull();
    expect(neededPerVersion("0", "20")).toBeNull();
  });

  it("parses goals and builds the preview parameter", () => {
    expect(parseGoal("event:signup")).toEqual({ kind: "event", event: "signup" });
    expect(parseGoal("form")).toEqual({ kind: "form", event: "" });
    expect(pbabParam(7, "b")).toBe("&pbab=7%3Ab");
  });
});
