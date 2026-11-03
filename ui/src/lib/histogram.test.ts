import { describe, expect, it } from "vitest";
import { buildHistogram } from "./histogram";

describe("buildHistogram", () => {
  it("returns null for no usable values", () => {
    expect(buildHistogram([])).toBeNull();
    expect(buildHistogram([NaN])).toBeNull();
  });

  it("collapses identical values to one bin", () => {
    expect(buildHistogram([5, 5, 5])).toMatchObject({ bins: [3], min: 5, max: 5, binSize: 0 });
  });

  it("matches the backend binning and percentiles", () => {
    // 10 values -> Sturges ceil(log2 10)+1 = 5 bins over 0..9.
    const data = buildHistogram([9, 0, 1, 2, 3, 4, 5, 6, 7, 8])!;
    expect(data.bins).toEqual([2, 2, 2, 2, 2]);
    expect(data.binSize).toBeCloseTo(1.8, 9);
    expect(data.p50).toBeCloseTo(4.5, 9);
    expect(data.p10).toBeCloseTo(0.9, 9);
  });
});
