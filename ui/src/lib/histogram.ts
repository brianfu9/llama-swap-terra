// Request-count histogram, a port of the backend's calculateHistogramData
// (internal/store/store.go) so the UI can bin a speed it derives itself, such
// as the system decode rate. Keep the two in step: same Sturges bin count
// clamped to 5..20, same linearly interpolated percentiles.

import type { HistogramData } from "./types";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return sorted[lower] + (rank - lower) * (sorted[upper] - sorted[lower]);
}

export function buildHistogram(values: number[]): HistogramData | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p50 = percentile(sorted, 50);
  const p10 = percentile(sorted, 10);
  const p1 = percentile(sorted, 1);
  if (min === max) {
    return { bins: [sorted.length], min, max, binSize: 0, p50, p10, p1 };
  }
  const sturges = Math.ceil(Math.log2(sorted.length)) + 1;
  const binCount = Math.min(20, Math.max(5, sturges));
  const binSize = (max - min) / binCount;
  const bins = new Array<number>(binCount).fill(0);
  for (const v of sorted) bins[Math.min(Math.floor((v - min) / binSize), binCount - 1)]++;
  return { bins, min, max, binSize, p50, p10, p1 };
}
