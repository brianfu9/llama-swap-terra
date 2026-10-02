import { describe, expect, it } from "vitest";
import { axisFill, buildHeatGrid, gridSize } from "./heatmap";
import {
  densityAlpha,
  densityBucket,
  densityThresholds,
  densityColor,
  densityRamp,
  latestSession,
  withAlpha,
} from "./scatterColor";

describe("buildHeatGrid", () => {
  it("returns an empty grid for no usable points", () => {
    expect(buildHeatGrid([], { xScale: "linear", xBins: 4, yBins: 4 })).toEqual({
      cells: [],
      maxCount: 0,
    });
    const junk = [{ x: NaN, y: 1 }, { x: 1, y: Infinity }];
    expect(buildHeatGrid(junk, { xScale: "linear", xBins: 4, yBins: 4 }).cells).toEqual([]);
  });

  it("counts points into bins spanning the data extent, not the axis", () => {
    // Extent is 1..9 on both axes, so 2 bins give edges 1/5/9 - the grid
    // starts at the smallest point, not at zero.
    const points = [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 9, y: 9 },
    ];
    const grid = buildHeatGrid(points, { xScale: "linear", xBins: 2, yBins: 2 });
    expect(grid.maxCount).toBe(2);
    expect(grid.cells).toHaveLength(2);
    const dense = grid.cells.find((c) => c.count === 2);
    expect(dense).toMatchObject({ x0: 1, x1: 5, y0: 1, y1: 5, cx: 3, cy: 3 });
    const sparse = grid.cells.find((c) => c.count === 1);
    expect(sparse).toMatchObject({ x0: 5, x1: 9, y0: 5, y1: 9 });
  });

  it("places a point on the top edge in the last bin rather than out of range", () => {
    const grid = buildHeatGrid([{ x: 0, y: 0 }, { x: 10, y: 10 }], {
      xScale: "linear",
      xBins: 2,
      yBins: 2,
    });
    expect(grid.cells).toHaveLength(2);
    expect(grid.cells.every((c) => c.count === 1)).toBe(true);
    expect(grid.cells.some((c) => c.x1 === 10 && c.y1 === 10)).toBe(true);
  });

  it("sorts cells so the densest paint last", () => {
    const points = [
      { x: 1, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 1 },
      { x: 9, y: 9 },
      { x: 9, y: 1 },
      { x: 9, y: 1 },
    ];
    const grid = buildHeatGrid(points, { xScale: "linear", xBins: 2, yBins: 2 });
    const counts = grid.cells.map((c) => c.count);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  it("bins evenly in log space and centers on the geometric mean", () => {
    // 1..10000 over 4 log bins -> edges at 1, 10, 100, 1000, 10000.
    const points = [{ x: 1, y: 0 }, { x: 5, y: 0 }, { x: 10000, y: 0 }];
    const grid = buildHeatGrid(points, { xScale: "logarithmic", xBins: 4, yBins: 1 });
    const first = grid.cells.find((c) => c.count === 2);
    expect(first?.x0).toBeCloseTo(1, 6);
    expect(first?.x1).toBeCloseTo(10, 6);
    // Geometric, not arithmetic (which would be 5.5).
    expect(first?.cx).toBeCloseTo(Math.sqrt(10), 6);
  });

  it("drops non-positive x on a log grid only", () => {
    const points = [{ x: 0, y: 1 }, { x: -5, y: 1 }, { x: 10, y: 1 }];
    expect(buildHeatGrid(points, { xScale: "logarithmic", xBins: 2, yBins: 2 }).maxCount).toBe(1);
    expect(buildHeatGrid(points, { xScale: "linear", xBins: 2, yBins: 2 }).maxCount).toBe(2);
  });

  it("collapses a zero-width extent into a single zero-size cell", () => {
    const grid = buildHeatGrid([{ x: 7, y: 3 }, { x: 7, y: 3 }], {
      xScale: "linear",
      xBins: 8,
      yBins: 8,
    });
    expect(grid.cells).toHaveLength(1);
    expect(grid.cells[0]).toMatchObject({ x0: 7, x1: 7, y0: 3, y1: 3, cx: 7, cy: 3, count: 2 });
  });

  it("averages acceptance over only the points that reported it", () => {
    const points = [
      { x: 1, y: 1, accept: 0.4 },
      { x: 1, y: 1, accept: 0.6 },
      { x: 1, y: 1, accept: -1 },
    ];
    const grid = buildHeatGrid(points, { xScale: "linear", xBins: 1, yBins: 1 });
    expect(grid.cells[0].count).toBe(3);
    expect(grid.cells[0].accept).toBeCloseTo(0.5, 6);
  });

  it("reports -1 acceptance when no point in the cell had draft data", () => {
    const grid = buildHeatGrid([{ x: 1, y: 1 }, { x: 1, y: 1, accept: -1 }], {
      xScale: "linear",
      xBins: 1,
      yBins: 1,
    });
    expect(grid.cells[0].accept).toBe(-1);
  });

  it("rejects a degenerate bin count", () => {
    expect(buildHeatGrid([{ x: 1, y: 1 }], { xScale: "linear", xBins: 0, yBins: 4 }).cells).toEqual([]);
  });
});

describe("gridSize", () => {
  it("scales resolution with the point count, within bounds", () => {
    expect(gridSize(0).xBins).toBe(8);
    expect(gridSize(9).xBins).toBe(8);
    expect(gridSize(100).xBins).toBe(20);
    expect(gridSize(100000).xBins).toBe(40);
  });

  it("keeps cells wider than they are tall", () => {
    const { xBins, yBins } = gridSize(400);
    expect(yBins).toBeLessThan(xBins);
    expect(yBins).toBeGreaterThanOrEqual(5);
  });

  it("thins the vertical count when the data covers little of the axis", () => {
    expect(gridSize(400, 1).yBins).toBe(24);
    expect(gridSize(400, 0.5).yBins).toBe(12);
    // Floored, so a very tall axis over a flat band still gets real rows.
    expect(gridSize(400, 0.01).yBins).toBe(5);
    expect(gridSize(400, NaN).yBins).toBe(24);
  });
});

describe("axisFill", () => {
  it("reports the share of a zero-based axis the data covers", () => {
    expect(axisFill([50, 100])).toBeCloseTo(0.5, 6);
    expect(axisFill([0, 100])).toBeCloseTo(1, 6);
  });

  it("clamps a narrow band to the floor", () => {
    expect(axisFill([99, 100])).toBeCloseTo(0.15, 6);
  });

  it("falls back to a full axis when there is nothing usable", () => {
    expect(axisFill([])).toBe(1);
    expect(axisFill([NaN, Infinity])).toBe(1);
    expect(axisFill([-5, 0])).toBe(1);
  });
});

describe("density color helpers", () => {
  it("has 7 steps per mode running opposite directions", () => {
    expect(densityRamp(false)).toHaveLength(7);
    expect(densityRamp(true)).toHaveLength(7);
    // Light darkens with density; dark brightens. They are NOT reverses of
    // each other - each stays inside its own mode's ordinal-safe band.
    expect(densityRamp(false)[0]).toBe("#86b6ef");
    expect(densityRamp(true)[0]).toBe("#184f95");
  });

  it("gives each ramp step a comparable share of the cells", () => {
    // Skewed: one hot cell among many sparse ones must not define the scale.
    const skewed = [...Array(60).fill(1), ...Array(30).fill(5), ...Array(9).fill(20), 225];
    const bounds = densityThresholds(skewed, 7);
    expect(bounds).toHaveLength(7);
    expect(bounds[bounds.length - 1]).toBe(225);
    // Monotonic non-decreasing upper bounds.
    expect(bounds).toEqual([...bounds].sort((a, b) => a - b));

    const hist = new Array(7).fill(0);
    for (const count of skewed) hist[densityBucket(count, bounds)]++;
    // Every cell placed, and the top step is not swallowing the bulk of them.
    expect(hist.reduce((a, b) => a + b, 0)).toBe(skewed.length);
    expect(hist[6]).toBeLessThan(skewed.length / 2);
  });

  it("spreads an unskewed distribution across every step", () => {
    const even = Array.from({ length: 70 }, (_, i) => i + 1);
    const bounds = densityThresholds(even, 7);
    const hist = new Array(7).fill(0);
    for (const count of even) hist[densityBucket(count, bounds)]++;
    expect(hist.every((h) => h === 10)).toBe(true);
  });

  it("ignores empty cells and handles an empty grid", () => {
    expect(densityThresholds([], 7)).toEqual([]);
    expect(densityThresholds([0, 0], 7)).toEqual([]);
    expect(densityThresholds([3], 7)).toEqual([3, 3, 3, 3, 3, 3, 3]);
  });

  it("buckets by inclusive upper bound", () => {
    const bounds = [1, 2, 4, 6, 10, 16, 225];
    expect(densityBucket(0, bounds)).toBe(-1);
    expect(densityBucket(5, [])).toBe(-1);
    expect(densityBucket(1, bounds)).toBe(0);
    expect(densityBucket(2, bounds)).toBe(1);
    expect(densityBucket(3, bounds)).toBe(2);
    expect(densityBucket(16, bounds)).toBe(5);
    expect(densityBucket(225, bounds)).toBe(6);
  });

  it("clamps a count above the top bound to the last step", () => {
    expect(densityBucket(9999, [1, 2, 4, 6, 10, 16, 225])).toBe(6);
  });

  it("paints nothing for an empty cell", () => {
    const bounds = [1, 2, 4, 6, 10, 16, 225];
    expect(densityColor(0, bounds, false)).toBe("transparent");
    expect(densityColor(225, bounds, false)).toBe(densityRamp(false)[6]);
    expect(densityColor(225, bounds, true)).toBe(densityRamp(true)[6]);
    expect(densityColor(1, bounds, false)).toBe(densityRamp(false)[0]);
  });

  it("keeps a populated cell visible on the alpha channel", () => {
    const bounds = [1, 2, 4, 6, 10, 16, 225];
    expect(densityAlpha(0, bounds)).toBe(0);
    expect(densityAlpha(225, bounds)).toBeCloseTo(1, 6);
    // Floor is well clear of invisible.
    expect(densityAlpha(1, bounds)).toBeGreaterThanOrEqual(0.35);
  });

  it("appends a clamped alpha channel", () => {
    expect(withAlpha("#2a78d6", 1)).toBe("#2a78d6ff");
    expect(withAlpha("#2a78d6", 0)).toBe("#2a78d600");
    expect(withAlpha("#2a78d6", 0.5)).toBe("#2a78d680");
    expect(withAlpha("#2a78d6", 5)).toBe("#2a78d6ff");
  });
});

describe("latestSession", () => {
  it("returns the session appearing last in chronological order", () => {
    expect(latestSession(["a", "b", "a", "c"])).toBe("c");
  });

  it("skips trailing sessionless points", () => {
    expect(latestSession(["a", "b", "", ""])).toBe("b");
  });

  it("returns empty when nothing carries a session", () => {
    expect(latestSession(["", ""])).toBe("");
    expect(latestSession([])).toBe("");
  });
});
