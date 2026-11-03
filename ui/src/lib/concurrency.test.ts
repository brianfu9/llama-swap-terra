import { describe, expect, it } from "vitest";
import { activeDecodeMs, buildConcurrency, MIN_LEVEL_BUSY_MS, slowdownAt } from "./concurrency";

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

  it("places only the active decode time of a preempted request", () => {
    // Five requests all report a window starting at t=0, but each was out of
    // the batch for all but its last 4000ms; the active windows
    // [2000i, 2000i+4000] overlap at most two at a time.
    const samples = [0, 1, 2, 3, 4].map((i) => {
      const end = 2000 * i + 4000;
      return { endMs: end, decodeMs: end, preemptedMs: end - 4000, output: 200, speed: (200 / end) * 1000 };
    });
    expect(buildConcurrency(samples.map(({ preemptedMs: _, ...s }) => s)).maxK).toBe(5);
    const data = buildConcurrency(samples);
    expect(data.maxK).toBe(2);
    for (const seg of data.segments) expect(seg.k).toBeLessThanOrEqual(2);
    // Speed is output over active time: 200 tokens / 4s.
    for (const p of data.points) expect(p.speed).toBeCloseTo(50, 6);
    expect(data.sumMs).toBe(5 * 4000);
  });

  it("falls back to the whole decode when preempted_ms is unusable", () => {
    expect(activeDecodeMs(1000, undefined)).toBe(1000);
    expect(activeDecodeMs(1000, 0)).toBe(1000);
    expect(activeDecodeMs(1000, -5)).toBe(1000);
    expect(activeDecodeMs(1000, NaN)).toBe(1000);
    expect(activeDecodeMs(1000, 1000)).toBe(1000);
    expect(activeDecodeMs(1000, 1500)).toBe(1000);
    expect(activeDecodeMs(1000, 250)).toBe(750);
  });

  it("interpolates the slowdown linearly between whole levels", () => {
    const byK = new Map([
      [2, 1.08],
      [3, 1.37],
      [4, 1.38],
    ]);
    expect(slowdownAt(0.5, byK)).toBe(1);
    expect(slowdownAt(1, byK)).toBe(1);
    expect(slowdownAt(1.5, byK)).toBeCloseTo(1.04, 9);
    expect(slowdownAt(2, byK)).toBeCloseTo(1.08, 9);
    expect(slowdownAt(2.5, byK)).toBeCloseTo(1.225, 9);
    expect(slowdownAt(4, byK)).toBeCloseTo(1.38, 9);
    // No level 5: no extrapolation.
    expect(slowdownAt(4.2, byK)).toBeNaN();
    expect(slowdownAt(2.5, new Map([[2, 1.08]]))).toBeNaN();
  });

  it("scales a shared request to its solo-equivalent speed", () => {
    // X 0..180s at 50 tok/s; Y 120..300s at 30 tok/s (60s together); then a
    // pair P side by side 300..420s at 20 tok/s each.
    //   solo: 120s x 50 + 120s x 30 = 9600 tok / 240s = 40 tok/s
    //   k=2:  60s x 80 + 120s x 40 = 9600 tok / 180s = 53.3 tok/s
    //   speedup 4/3, slowdown 2 / (4/3) = 1.5
    const data = buildConcurrency([
      decode(180_000, 180_000, 9000),
      decode(300_000, 180_000, 5400),
      decode(420_000, 120_000, 2400),
      decode(420_000, 120_000, 2400),
    ]);
    expect(data.soloTps).toBeCloseTo(40, 6);
    expect(data.levels.find((l) => l.k === 1)!.slowdown).toBe(1);
    expect(data.levels.find((l) => l.k === 2)!.slowdown).toBeCloseTo(1.5, 9);
    const [x, y, p1, p2] = data.points;
    // The pair ran at k=2 throughout: 20 x 1.5 = 30, the solo rate's scale.
    expect(p1.meanK).toBeCloseTo(2, 9);
    expect(p1.soloEquiv).toBeCloseTo(30, 6);
    expect(p2.soloEquiv).toBeCloseTo(30, 6);
    // X and Y: mean k = (120 + 2 x 60) / 180 = 4/3 -> slowdown 1 + (1/3)(0.5).
    expect(y.meanK).toBeCloseTo(4 / 3, 9);
    expect(y.soloEquiv).toBeCloseTo(30 * (7 / 6), 6);
    expect(x.soloEquiv).toBeCloseTo(50 * (7 / 6), 6);
    expect(data.soloSpeeds).toEqual(data.points.map((p) => p.soloEquiv));
  });

  it("leaves a solo request's solo-equivalent at its speed", () => {
    const data = buildConcurrency([{ endMs: 120_000, decodeMs: 120_000, output: 6000, speed: 49.7 }]);
    expect(data.points[0].soloEquiv).toBe(49.7);
    expect(data.soloSpeeds[0]).toBe(49.7);
  });

  it("keeps the raw speed without a trusted baseline or level", () => {
    // Nothing ran alone: no baseline.
    let data = buildConcurrency([decode(120_000, 120_000, 3000), decode(120_000, 120_000, 3000)]);
    expect(data.levels[0].slowdown).toBe(0);
    for (const p of data.points) expect(p.soloEquiv).toBe(p.speed);

    // Trusted solo, but k=2 seen for only 4s.
    expect(4000).toBeLessThan(MIN_LEVEL_BUSY_MS);
    data = buildConcurrency([decode(120_000, 120_000, 6000), decode(124_000, 4000, 140), decode(124_000, 4000, 140)]);
    expect(data.levels.find((l) => l.k === 2)!.slowdown).toBe(0);
    expect(data.points[1].soloEquiv).toBe(data.points[1].speed);

    // Solo baseline itself too short, even with a long k=2 level.
    data = buildConcurrency([decode(2000, 2000, 100), decode(122_000, 120_000, 4200), decode(122_000, 120_000, 4200)]);
    expect(data.levels.find((l) => l.k === 2)!.slowdown).toBe(0);
    for (const p of data.points) expect(p.soloEquiv).toBe(p.speed);
    // Untimed samples stay NaN.
    data = buildConcurrency([{ endMs: 0, decodeMs: -1, output: 10, speed: 33 }]);
    expect(data.soloSpeeds[0]).toBeNaN();
  });
});
