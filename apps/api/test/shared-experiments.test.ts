import { assignArm, compareToControl, estimateDaysLeft, experimentVerdict, requiredSampleSize, sampleRatioPValue } from "@paperboy/shared";
import { describe, expect, it } from "vitest";

/** The pure half of A/B experiments (#125): assignment and the statistics. */

const AB = [
  { key: "a", weight: 50 },
  { key: "b", weight: 50 },
];

describe("assignArm", () => {
  it("is deterministic per (experiment, visitor) and gives the control without a visitor key", () => {
    expect(assignArm(7, "visitor-1", AB)).toBe(assignArm(7, "visitor-1", AB));
    expect(assignArm(7, null, AB)).toBe("a");
    expect(assignArm(7, "", AB)).toBe("a");
  });

  it("splits visitors by weight", () => {
    const arms = [{ key: "a", weight: 70 }, { key: "b", weight: 20 }, { key: "c", weight: 10 }];
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 20_000; i++) counts[assignArm(42, `v${i}`, arms)]!++;
    expect(counts.a! / 20_000).toBeCloseTo(0.7, 1);
    expect(counts.b! / 20_000).toBeCloseTo(0.2, 1);
    expect(counts.c! / 20_000).toBeCloseTo(0.1, 1);
  });

  it("assigns independently per experiment", () => {
    const same = Array.from({ length: 2000 }, (_, i) => assignArm(1, `v${i}`, AB) === assignArm(2, `v${i}`, AB)).filter(Boolean).length;
    expect(same / 2000).toBeCloseTo(0.5, 1);
  });

  it("gives the control when every weight is zero", () => {
    expect(assignArm(1, "v", [{ key: "a", weight: 0 }, { key: "b", weight: 0 }])).toBe("a");
  });
});

describe("statistics", () => {
  it("sample size: n ≈ 16·p(1−p)/δ² with δ = p·mde", () => {
    expect(requiredSampleSize(0.05, 0.2)).toBe(7600);
    expect(requiredSampleSize(0, 0.2)).toBeNull();
    expect(requiredSampleSize(0.05, 0)).toBeNull();
  });

  it("two-proportion z-test against the control", () => {
    const c = compareToControl({ exposures: 1000, conversions: 100 }, { exposures: 1000, conversions: 130 })!;
    expect(c.lift).toBeCloseTo(0.3, 5);
    expect(c.pValue).toBeCloseTo(0.0355, 3);
    expect(c.diffLow).toBeGreaterThan(0);
    expect(compareToControl({ exposures: 0, conversions: 0 }, { exposures: 10, conversions: 1 })).toBeNull();
  });

  it("sample ratio mismatch", () => {
    expect(sampleRatioPValue([5000, 5000], [50, 50])).toBeCloseTo(1, 5);
    expect(sampleRatioPValue([5000, 5500], [50, 50])).toBeLessThan(0.001);
    expect(sampleRatioPValue([1000, 1010, 990], [1, 1, 1])).toBeGreaterThan(0.5);
    expect(sampleRatioPValue([1000, 1010, 990, 1000], [1, 1, 1, 1])).toBeGreaterThan(0.5);
  });
});

describe("experimentVerdict never names a winner early", () => {
  const plan = { baselineRate: 0.1, mde: 0.3 }; // n = 16·.09/.0009 = 1600
  it("says how far along it is before the planned sample size", () => {
    const { verdict } = experimentVerdict([{ key: "a", weight: 50, exposures: 400, conversions: 30 }, { key: "b", weight: 50, exposures: 420, conversions: 80 }], plan);
    expect(verdict).toMatchObject({ complete: false, leader: null, needed: 1600 });
    expect(verdict.summary).toBe("Not conclusive yet: 400 of 1600 visitors per version.");
  });

  it("names the leader once complete and significant", () => {
    const { verdict, results } = experimentVerdict([{ key: "a", weight: 50, exposures: 2000, conversions: 200 }, { key: "b", weight: 50, exposures: 2000, conversions: 280 }], plan);
    expect(verdict).toMatchObject({ complete: true, leader: "b", srmWarning: false });
    expect(results[1]!.comparison!.lift).toBeCloseTo(0.4, 5);
  });

  it("reports no difference honestly", () => {
    const { verdict } = experimentVerdict([{ key: "a", weight: 50, exposures: 2000, conversions: 200 }, { key: "b", weight: 50, exposures: 2000, conversions: 205 }], plan);
    expect(verdict).toMatchObject({ complete: true, leader: null });
    expect(verdict.summary).toMatch(/No significant difference/);
  });

  it("withholds a leader when the split is broken", () => {
    const { verdict } = experimentVerdict([{ key: "a", weight: 50, exposures: 2000, conversions: 200 }, { key: "b", weight: 50, exposures: 3000, conversions: 450 }], plan);
    expect(verdict).toMatchObject({ srmWarning: true, leader: null });
  });

  it("asks for a plan before reading a winner", () => {
    const { verdict } = experimentVerdict([{ key: "a", weight: 50, exposures: 10, conversions: 1 }, { key: "b", weight: 50, exposures: 10, conversions: 2 }], {});
    expect(verdict.summary).toMatch(/No sample size planned/);
  });
});

describe("estimateDaysLeft", () => {
  it("days until the slowest version reaches the sample size, at the measured traffic", () => {
    // 100 visitors a day split 50/50 → 50 per version per day; B needs 1000 − 400 = 600 more → 12 days.
    expect(estimateDaysLeft(1000, [{ weight: 50, exposures: 500 }, { weight: 50, exposures: 400 }], 100)).toBe(12);
    // A smaller share takes longer: 20 % of 100 a day → 20/day for 600 → 30 days.
    expect(estimateDaysLeft(1000, [{ weight: 80, exposures: 800 }, { weight: 20, exposures: 400 }], 100)).toBe(30);
    expect(estimateDaysLeft(1000, [{ weight: 50, exposures: 1000 }, { weight: 50, exposures: 1200 }], 100)).toBe(0);
  });
  it("is null without a plan or without traffic", () => {
    expect(estimateDaysLeft(null, [{ weight: 50, exposures: 1 }], 10)).toBeNull();
    expect(estimateDaysLeft(1000, [{ weight: 50, exposures: 0 }], null)).toBeNull();
  });
});
