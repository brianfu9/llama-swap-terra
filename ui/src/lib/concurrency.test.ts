import { describe, expect, it } from "vitest";
import { buildConcurrency } from "./concurrency";

// A decode of `output` tokens at `speed` tok/s that finished at endMs.
const decode = (endMs: number, decodeMs: number, output: number) => ({
  endMs,
  decodeMs,
  output,
  speed: (output / decodeMs) * 1000,
});

describe("buildConcurrency", () => {
  it("returns empty data for no samples", () => {
    const data = buildConcurrency([]);
    expect(data.levels).toEqual([]);
    expect(data.timed).toBe(0);
  });

  it("counts untimed requests instead of placing them", () => {
    const data = buildConcurrency([
      { endMs: 1000, decodeMs: -1, output: 10, speed: 10 },
      { endMs: 0, decodeMs: 500, output: 10, speed: 10 },
      decode(1000, 1000, 50),
    ]);
    expect(data.timed).toBe(1);
    expect(data.untimed).toBe(2);
  });

  it("reports k = 1 and no speedup for back-to-back decodes", () => {
    // Touching at t=1000 is not an overlap.
    const data = buildConcurrency([decode(1000, 1000, 50), decode(2000, 1000, 50)]);
    expect(data.maxK).toBe(1);
    expect(data.meanConcurrency).toBeCloseTo(1, 6);
    expect(data.systemTps).toBeCloseTo(50, 6);
    expect(data.perStreamTps).toBeCloseTo(50, 6);
    expect(data.levels).toHaveLength(1);
    expect(data.levels[0].speedup).toBeCloseTo(1, 6);
  });

  it("shows the system faster while each stream is slower", () => {
    // Solo: 50 tok/s for 2s. Then two streams side by side for 4s at 35 tok/s
    // each - each stream is slower, the system makes 70 tok/s.
    const data = buildConcurrency([
      decode(2000, 2000, 100),
      decode(6000, 4000, 140),
      decode(6000, 4000, 140),
    ]);
    expect(data.maxK).toBe(2);
    expect(data.soloTps).toBeCloseTo(50, 6);
    const two = data.levels.find((l) => l.k === 2)!;
    expect(two.systemTps).toBeCloseTo(70, 6);
    expect(two.perStreamMedian).toBeCloseTo(35, 6);
    expect(two.speedup).toBeCloseTo(1.4, 6);
    expect(two.idealTps).toBeCloseTo(100, 6);
    expect(two.share).toBeCloseTo(4 / 6, 6);
    // Union 6s, summed 10s: 380 tokens.
    expect(data.systemTps).toBeCloseTo(380 / 6, 6);
    expect(data.perStreamTps).toBeCloseTo(38, 6);
    expect(data.meanConcurrency).toBeCloseTo(10 / 6, 6);
  });

  it("places a request by its time-weighted mean k", () => {
    // A runs 0..4000; B overlaps only its last 1000ms -> A's mean k = 1.25.
    const data = buildConcurrency([decode(4000, 4000, 200), decode(5000, 2000, 100)]);
    const a = data.points.find((p) => Math.abs(p.speed - 50) < 1e-9)!;
    expect(a.meanK).toBeCloseTo(1.25, 6);
    expect(a.k).toBe(1);
    // B: 1000ms at k=2, 1000ms at k=1 -> 1.5, rounds to 2.
    const b = data.points.find((p) => p !== a)!;
    expect(b.meanK).toBeCloseTo(1.5, 6);
    expect(b.k).toBe(2);
  });

  it("has no speedup baseline when nothing ran alone", () => {
    const data = buildConcurrency([decode(1000, 1000, 30), decode(1000, 1000, 30)]);
    expect(data.soloTps).toBe(0);
    expect(data.levels[0].k).toBe(2);
    expect(data.levels[0].speedup).toBe(0);
  });

  it("gives each request the system rate averaged over its own decode", () => {
    // A runs 0..4000 alone at 50 tok/s for 3000ms, then shares 1000ms with B.
    // B runs 3000..5000: 1000ms shared, 1000ms alone, 50 tok/s.
    const untimed = { endMs: 0, decodeMs: -1, output: 10, speed: 33 };
    const data = buildConcurrency([decode(4000, 4000, 200), untimed, decode(5000, 2000, 100)]);
    // Shared stretch: 50 + 50 = 100 tok/s.
    expect(data.systemSpeeds).toHaveLength(3);
    expect(data.systemSpeeds[0]).toBeCloseTo((3000 * 50 + 1000 * 100) / 4000, 6);
    expect(Number.isNaN(data.systemSpeeds[1])).toBe(true);
    expect(data.systemSpeeds[2]).toBeCloseTo((1000 * 100 + 1000 * 50) / 2000, 6);
  });

  it("leaves a solo request at its reported speed", () => {
    const data = buildConcurrency([{ endMs: 1000, decodeMs: 1000, output: 50, speed: 49.7 }]);
    expect(data.systemSpeeds[0]).toBe(49.7);
  });
});
