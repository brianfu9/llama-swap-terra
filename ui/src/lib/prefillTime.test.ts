import { describe, expect, it } from "vitest";
import { buildPrefillTime } from "./prefillTime";

describe("buildPrefillTime", () => {
  it("returns empty data for no samples", () => {
    const data = buildPrefillTime([]);
    expect(data.bins).toEqual([]);
    expect(data.totalSeconds).toBe(0);
    expect(data.timed).toBe(0);
    expect(data.untimed).toBe(0);
  });

  it("sums seconds rather than counting requests", () => {
    // Speeds 10..100 over 2 linear bins -> edges 10, 55, 100.
    // Bin 0: 500 trivial requests at 1ms each = 0.5s total.
    // Bin 1: 2 requests at 10s each = 20s total.
    const samples = [
      ...Array.from({ length: 500 }, () => ({ speed: 10, prefillMs: 1 })),
      { speed: 100, prefillMs: 10000 },
      { speed: 90, prefillMs: 10000 },
    ];
    const data = buildPrefillTime(samples, 2);
    expect(data.bins).toHaveLength(2);
    expect(data.bins[0].count).toBe(500);
    expect(data.bins[0].seconds).toBeCloseTo(0.5, 6);
    expect(data.bins[1].count).toBe(2);
    expect(data.bins[1].seconds).toBeCloseTo(20, 6);
    // The point of the chart: the 2-request bin outweighs the 500-request one.
    expect(data.bins[1].seconds).toBeGreaterThan(data.bins[0].seconds);
    expect(data.bins[1].share).toBeCloseTo(20 / 20.5, 6);
  });

  it("reports mean seconds per request alongside the total", () => {
    const data = buildPrefillTime(
      [
        { speed: 10, prefillMs: 2000 },
        { speed: 10, prefillMs: 4000 },
      ],
      1,
    );
    expect(data.bins[0].count).toBe(2);
    expect(data.bins[0].seconds).toBeCloseTo(6, 6);
    expect(data.bins[0].meanSeconds).toBeCloseTo(3, 6);
  });

  it("counts untimed samples separately and gives them no time", () => {
    const data = buildPrefillTime([
      { speed: 10, prefillMs: 1000 },
      { speed: 10, prefillMs: -1 },
      { speed: 10, prefillMs: 0 },
      { speed: 10 },
    ]);
    expect(data.timed).toBe(1);
    expect(data.untimed).toBe(3);
    expect(data.totalSeconds).toBeCloseTo(1, 6);
  });

  it("returns untimed-only data without bins", () => {
    const data = buildPrefillTime([{ speed: 10, prefillMs: -1 }]);
    expect(data.bins).toEqual([]);
    expect(data.untimed).toBe(1);
    expect(data.timed).toBe(0);
  });

  it("drops non-positive and non-finite speeds", () => {
    const data = buildPrefillTime([
      { speed: 0, prefillMs: 1000 },
      { speed: -5, prefillMs: 1000 },
      { speed: NaN, prefillMs: 1000 },
      { speed: 10, prefillMs: 1000 },
    ]);
    expect(data.timed).toBe(1);
    expect(data.untimed).toBe(0);
  });

  it("spaces bin edges evenly in tokens/sec", () => {
    const data = buildPrefillTime(
      [
        { speed: 100, prefillMs: 1000 },
        { speed: 400, prefillMs: 1000 },
      ],
      3,
    );
    expect(data.bins).toHaveLength(3);
    expect(data.bins[0].lo).toBeCloseTo(100, 6);
    expect(data.bins[0].hi).toBeCloseTo(200, 6);
    expect(data.bins[1].hi).toBeCloseTo(300, 6);
    expect(data.bins[2].hi).toBeCloseTo(400, 6);
  });

  it("places the fastest request in the last bin, not out of range", () => {
    const data = buildPrefillTime(
      [
        { speed: 100, prefillMs: 1000 },
        { speed: 400, prefillMs: 5000 },
      ],
      3,
    );
    expect(data.bins[2].count).toBe(1);
    expect(data.bins[2].seconds).toBeCloseTo(5, 6);
  });

  it("collapses a single distinct speed into one bin", () => {
    const data = buildPrefillTime(
      [
        { speed: 42, prefillMs: 1000 },
        { speed: 42, prefillMs: 3000 },
      ],
      18,
    );
    expect(data.bins).toHaveLength(1);
    expect(data.bins[0]).toMatchObject({ lo: 42, hi: 42, count: 2 });
    expect(data.bins[0].seconds).toBeCloseTo(4, 6);
    expect(data.bins[0].share).toBeCloseTo(1, 6);
  });

  it("rejects a degenerate bin count", () => {
    expect(buildPrefillTime([{ speed: 10, prefillMs: 1000 }], 0).bins).toEqual([]);
  });

  it("tracks the maximum bin total for scaling", () => {
    const data = buildPrefillTime(
      [
        { speed: 10, prefillMs: 1000 },
        { speed: 100, prefillMs: 7000 },
      ],
      2,
    );
    expect(data.maxSeconds).toBeCloseTo(7, 6);
  });
});

describe("time-weighted percentiles", () => {
  it("splits on time spent, not on request count", () => {
    // 99 fast requests costing 1ms each (0.099s), one slow request at 10s.
    // By count the median speed is 1000; by TIME the slow request owns >99%
    // of the budget, so every percentile should sit at the slow end.
    const samples = [
      ...Array.from({ length: 99 }, () => ({ speed: 1000, prefillMs: 1 })),
      { speed: 10, prefillMs: 10000 },
    ];
    const data = buildPrefillTime(samples);
    expect(data.p50).toBe(10);
    expect(data.p10).toBe(10);
    expect(data.p1).toBe(10);
  });

  it("orders p1 <= p10 <= p50 on a spread of speeds", () => {
    const samples = Array.from({ length: 100 }, (_, i) => ({
      speed: i + 1,
      prefillMs: 1000,
    }));
    const data = buildPrefillTime(samples);
    expect(data.p1).toBeLessThanOrEqual(data.p10);
    expect(data.p10).toBeLessThanOrEqual(data.p50);
    // Equal weights, so time percentiles match count percentiles here.
    expect(data.p50).toBe(50);
    expect(data.p10).toBe(10);
  });

  it("reports zero percentiles when nothing is timed", () => {
    const data = buildPrefillTime([{ speed: 100, prefillMs: -1 }]);
    expect(data.p50).toBe(0);
    expect(data.p10).toBe(0);
    expect(data.p1).toBe(0);
  });

  it("collapses all percentiles onto a single observed speed", () => {
    const data = buildPrefillTime([
      { speed: 42, prefillMs: 1000 },
      { speed: 42, prefillMs: 2000 },
    ]);
    expect(data.p1).toBe(42);
    expect(data.p50).toBe(42);
  });
});
