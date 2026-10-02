// 2D density binning for the activity-page speed charts.
//
// The scatter plots these replaced drew one dot per request. Past a few
// hundred requests the interesting region saturates into a solid blob: every
// dot is drawn, none of them are readable, and the shape of the distribution —
// which is the whole point of the chart — is the one thing you cannot see.
// Binning to a grid and encoding count as color keeps that shape legible at
// any row count, and the per-request detail comes back through the overlay of
// the single latest session, which is small enough to draw as real dots.
//
// The binning is pure and lives here so it can be tested without a canvas;
// heatmapPlugin is the only part that touches Chart.js.

export type HeatScale = "linear" | "logarithmic";

/** One request's position in the chart, plus its draft acceptance if known. */
export interface HeatSource {
  x: number;
  y: number;
  /** 0..1, or -1/undefined when the request reported no draft tokens. */
  accept?: number;
}

/**
 * One populated grid cell. Bounds are in data space — on a log grid the bin
 * edges are evenly spaced in log10, so x0/x1 are not evenly spaced in x and
 * cx is the geometric, not arithmetic, mean.
 */
export interface HeatCell {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  cx: number;
  cy: number;
  count: number;
  /** Mean acceptance over the cell's points that reported one, else -1. */
  accept: number;
}

export interface HeatGrid {
  /** Populated cells only — empty bins are omitted rather than stored as 0. */
  cells: HeatCell[];
  maxCount: number;
}

export interface HeatGridOptions {
  xScale: HeatScale;
  xBins: number;
  yBins: number;
}

interface Accumulator {
  count: number;
  acceptSum: number;
  acceptCount: number;
}

/**
 * Bin count for a dataset of n points.
 *
 * Resolution has to follow the data volume: a fine grid over few points
 * degenerates into a one-request-per-cell scatter that reads worse than the
 * scatter it replaced, because every cell lands on the same ramp step. Scaling
 * with sqrt(n) keeps cells populated, and the caps keep cells inside a
 * readable 8-40px on the ~300px cards these charts render in. yAxisFill
 * corrects the vertical count for axes that extend past their data - see
 * axisFill.
 */
export function gridSize(n: number, yAxisFill = 1): { xBins: number; yBins: number } {
  const xBins = Math.max(8, Math.min(40, Math.round(Math.sqrt(Math.max(n, 0)) * 2)));
  const fill = Number.isFinite(yAxisFill) ? Math.min(1, Math.max(0.15, yAxisFill)) : 1;
  return { xBins, yBins: Math.max(5, Math.round(xBins * 0.6 * fill)) };
}

/**
 * The share of a zero-based axis its data actually covers, for gridSize's
 * yAxisFill.
 *
 * Bins are counted over the data extent but drawn over the axis range, and
 * these charts pin the speed axis to zero while the speeds themselves sit in a
 * narrow band near the top. Counting a full complement of bins across that
 * band squeezes each one into a few pixels, and the grid renders as a field of
 * horizontal dashes rather than cells.
 */
export function axisFill(values: number[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  if (!Number.isFinite(lo) || hi <= 0) return 1;
  return Math.min(1, Math.max(0.15, (hi - lo) / hi));
}

/**
 * Bin points into a count grid. Points that cannot be placed are dropped:
 * non-finite coordinates always, and non-positive x on a log grid.
 *
 * Bin edges span the data extent rather than the axis range, so an axis that
 * starts at zero over data that starts at 40k does not spend most of its bins
 * on empty space.
 */
export function buildHeatGrid(points: HeatSource[], opts: HeatGridOptions): HeatGrid {
  const { xScale, xBins, yBins } = opts;
  const log = xScale === "logarithmic";
  const empty: HeatGrid = { cells: [], maxCount: 0 };
  if (xBins < 1 || yBins < 1) return empty;

  const toAxis = (value: number) => (log ? Math.log10(value) : value);
  const fromAxis = (value: number) => (log ? 10 ** value : value);

  // One pass for the extent, avoiding Math.min(...array) — the activity table
  // is only row-capped, and a large spread blows the argument limit.
  let xLo = Infinity;
  let xHi = -Infinity;
  let yLo = Infinity;
  let yHi = -Infinity;
  let usable = 0;
  const placeable = (p: HeatSource) =>
    Number.isFinite(p.x) && Number.isFinite(p.y) && (!log || p.x > 0);

  for (const point of points) {
    if (!placeable(point)) continue;
    usable++;
    const x = toAxis(point.x);
    if (x < xLo) xLo = x;
    if (x > xHi) xHi = x;
    if (point.y < yLo) yLo = point.y;
    if (point.y > yHi) yHi = point.y;
  }
  if (usable === 0) return empty;

  const xStep = (xHi - xLo) / xBins;
  const yStep = (yHi - yLo) / yBins;

  // A zero step means every point shares that coordinate: collapse to one bin
  // rather than dividing by zero. The cell then has zero width or height and
  // the plugin draws it at its minimum pixel size.
  const binOf = (value: number, lo: number, step: number, bins: number) =>
    step > 0 ? Math.min(bins - 1, Math.max(0, Math.floor((value - lo) / step))) : 0;

  const buckets = new Map<number, Accumulator>();
  for (const point of points) {
    if (!placeable(point)) continue;
    const ix = binOf(toAxis(point.x), xLo, xStep, xBins);
    const iy = binOf(point.y, yLo, yStep, yBins);
    const key = iy * xBins + ix;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { count: 0, acceptSum: 0, acceptCount: 0 };
      buckets.set(key, bucket);
    }
    bucket.count++;
    if (point.accept !== undefined && point.accept >= 0) {
      bucket.acceptSum += point.accept;
      bucket.acceptCount++;
    }
  }

  const cells: HeatCell[] = [];
  let maxCount = 0;
  for (const [key, bucket] of buckets) {
    const ix = key % xBins;
    const iy = Math.floor(key / xBins);
    cells.push({
      x0: fromAxis(xLo + ix * xStep),
      x1: fromAxis(xLo + (ix + 1) * xStep),
      y0: yLo + iy * yStep,
      y1: yLo + (iy + 1) * yStep,
      cx: fromAxis(xLo + (ix + 0.5) * xStep),
      cy: yLo + (iy + 0.5) * yStep,
      count: bucket.count,
      accept: bucket.acceptCount > 0 ? bucket.acceptSum / bucket.acceptCount : -1,
    });
    if (bucket.count > maxCount) maxCount = bucket.count;
  }
  // Draw densest last so a hot cell is never painted over by a sparse one.
  cells.sort((a, b) => a.count - b.count);
  return { cells, maxCount };
}

/** Smallest cell edge in pixels, so a degenerate bin still renders. */
const MIN_CELL_PX = 2;
/** Cells above this size get a hairline gap so bins stay countable. */
const GAP_MIN_PX = 3;

/**
 * The slice of a Chart.js chart this layer touches, declared structurally
 * rather than as `Chart`. Importing the real generic here makes TypeScript
 * infer the registered plugin at a concrete chart type, which then makes every
 * `let chart: Chart` declaration in the app fail to accept its own
 * `new Chart(...)`. A structural type keeps the plugin chart-type-agnostic.
 */
export interface HeatmapChart {
  ctx: CanvasRenderingContext2D;
  chartArea: { left: number; right: number; top: number; bottom: number };
  scales: Record<string, { getPixelForValue(value: number): number } | undefined>;
}

export interface HeatmapState {
  grid: HeatGrid;
  colorFor: (cell: HeatCell) => string;
}

// Keyed off the chart instance rather than passed through plugin options:
// Chart.js plugin options are typed per chart type and would need a module
// augmentation to carry a non-serializable callback.
const states = new WeakMap<object, HeatmapState>();

/** Attach (or replace) the grid a chart's heatmap layer draws. */
export function setHeatmapState(chart: object, state: HeatmapState): void {
  states.set(chart, state);
}

/**
 * Draws the density grid underneath the datasets. Cell bounds are converted
 * through the live scales on every frame, so the layer follows axis changes
 * and resizes without rebinning.
 */
export const heatmapPlugin = {
  id: "heatmap",
  beforeDatasetsDraw(chart: HeatmapChart) {
    const state = states.get(chart);
    if (!state) return;
    const { ctx, chartArea, scales } = chart;
    const xScale = scales.x;
    const yScale = scales.y;
    if (!ctx || !chartArea || !xScale || !yScale) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(
      chartArea.left,
      chartArea.top,
      chartArea.right - chartArea.left,
      chartArea.bottom - chartArea.top,
    );
    ctx.clip();
    for (const cell of state.grid.cells) {
      const left = xScale.getPixelForValue(cell.x0);
      const right = xScale.getPixelForValue(cell.x1);
      // y grows upward, so the upper bound is the smaller pixel value.
      const top = yScale.getPixelForValue(cell.y1);
      const bottom = yScale.getPixelForValue(cell.y0);
      if (![left, right, top, bottom].every(Number.isFinite)) continue;
      const width = Math.max(right - left, MIN_CELL_PX);
      const height = Math.max(bottom - top, MIN_CELL_PX);
      const gap = width > GAP_MIN_PX && height > GAP_MIN_PX ? 1 : 0;
      ctx.fillStyle = state.colorFor(cell);
      ctx.fillRect(left + gap / 2, top + gap / 2, width - gap, height - gap);
    }
    ctx.restore();
  },
};
