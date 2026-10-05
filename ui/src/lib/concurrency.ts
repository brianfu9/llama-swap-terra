// Concurrency-aware decode throughput.
//
// Per-request decode speed falls when several agents decode at once, because
// they share one GPU. Read alone, that looks like a regression even when the
// system as a whole is producing more tokens per second. This module rebuilds
// each decode on the wall clock as [endMs - decodeMs, endMs] and measures:
//
//   - k, the number of decodes running at each instant;
//   - the system rate, the sum of every running decode's rate;
//   - per k, the system rate against the solo (k = 1) rate.
//
// A request's tokens are spread evenly over its decode. That is a smoothing:
// llama-server reports one predicted_ms per request, not a per-token trace.
//
// Prefill of one slot runs in the same batches as decode of another, so that
// time lands inside the other request's decode interval. The per-stream rate
// blames it on decode; the system rate counts it correctly, because tokens
// over union time does not care which slot owned the batch.

import { buildPrefillTime, type PrefillSample, type PrefillTimeData } from "./prefillTime";

/** One request's decode, as the stats endpoint reports it. */
export interface DecodeSample {
  /** Unix ms the response finished. */
  endMs?: number;
  /** llama-server's predicted_ms. <= 0 means the request reported no timing. */
  decodeMs?: number;
  output: number;
  /** Reported per-request decode rate, tokens/sec. */
  speed: number;
}

/** A stretch of wall clock with a constant set of running decodes. */
export interface DecodeSegment {
  start: number;
  end: number;
  k: number;
  /** Sum of the running decodes' rates, tokens/sec. */
  systemTps: number;
}

/** Totals for every stretch of wall clock that ran exactly k decodes. */
export interface ConcurrencyLevel {
  k: number;
  busyMs: number;
  /** Share of all busy time spent at this k, 0..1. */
  share: number;
  tokens: number;
  /** tokens / busy time at this k. */
  systemTps: number;
  /** Requests whose time-weighted mean k rounds to this k. */
  requests: number;
  /** Median reported per-request speed of those requests, or 0. */
  perStreamMedian: number;
  /** systemTps / solo systemTps, or 0 with no solo baseline. */
  speedup: number;
  /** k x solo systemTps: what perfect linear scaling would give. */
  idealTps: number;
}

/** One request placed by its time-weighted concurrency. */
export interface ConcurrencyPoint {
  /** Time-weighted mean of k over the request's decode. */
  meanK: number;
  /** meanK rounded to the nearest whole level, at least 1. */
  k: number;
  speed: number;
}

export interface ConcurrencyData {
  segments: DecodeSegment[];
  levels: ConcurrencyLevel[];
  points: ConcurrencyPoint[];
  totalTokens: number;
  /** Wall clock with at least one decode running. */
  unionMs: number;
  /** Sum of every decode's own duration. */
  sumMs: number;
  /** totalTokens / unionMs: what the system produced while busy. */
  systemTps: number;
  /** totalTokens / sumMs: the per-stream average the old summary showed. */
  perStreamTps: number;
  /** sumMs / unionMs. 1 means no decode ever overlapped another. */
  meanConcurrency: number;
  /** System rate at k = 1, the speedup baseline. 0 when nothing ran alone. */
  soloTps: number;
  maxK: number;
  timed: number;
  /** Requests dropped for having no decode timing or end time. */
  untimed: number;
}

const EMPTY: ConcurrencyData = {
  segments: [],
  levels: [],
  points: [],
  totalTokens: 0,
  unionMs: 0,
  sumMs: 0,
  systemTps: 0,
  perStreamTps: 0,
  meanConcurrency: 0,
  soloTps: 0,
  maxK: 0,
  timed: 0,
  untimed: 0,
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface Span {
  start: number;
  end: number;
  /** tokens per ms */
  rate: number;
  output: number;
  speed: number;
  /** Accumulated k x ms over the span, for the time-weighted mean k. */
  kMs: number;
}

export function buildConcurrency(samples: DecodeSample[]): ConcurrencyData {
  const spans: Span[] = [];
  let untimed = 0;
  for (const s of samples) {
    if (!Number.isFinite(s.speed) || s.speed <= 0 || !(s.output > 0)) continue;
    const end = s.endMs;
    const ms = s.decodeMs;
    // end_ms is 0 on a row the backend could not place (pre-migration
    // databases backfill it, so this is only a defensive check).
    if (end === undefined || !Number.isFinite(end) || end <= 0 || ms === undefined || !Number.isFinite(ms) || ms <= 0) {
      untimed++;
      continue;
    }
    spans.push({ start: end - ms, end, rate: s.output / ms, output: s.output, speed: s.speed, kMs: 0 });
  }
  if (spans.length === 0) return { ...EMPTY, untimed };

  // Sweep the start/end edges. Every edge at one instant is applied before
  // the next segment opens, so a decode ending exactly when another starts
  // does not count as an overlap.
  type Edge = { t: number; span: number; open: boolean };
  const edges: Edge[] = [];
  spans.forEach((sp, i) => {
    edges.push({ t: sp.start, span: i, open: true });
    edges.push({ t: sp.end, span: i, open: false });
  });
  edges.sort((a, b) => a.t - b.t);

  const active = new Set<number>();
  const segments: DecodeSegment[] = [];
  const busy = new Map<number, { ms: number; tokens: number }>();
  let unionMs = 0;
  let i = 0;
  while (i < edges.length) {
    const t = edges[i].t;
    while (i < edges.length && edges[i].t === t) {
      if (edges[i].open) active.add(edges[i].span);
      else active.delete(edges[i].span);
      i++;
    }
    if (i >= edges.length || active.size === 0) continue;
    const next = edges[i].t;
    const dur = next - t;
    if (dur <= 0) continue;
    const k = active.size;
    let rate = 0;
    for (const idx of active) {
      rate += spans[idx].rate;
      spans[idx].kMs += k * dur;
    }
    segments.push({ start: t, end: next, k, systemTps: rate * 1000 });
    const level = busy.get(k) ?? { ms: 0, tokens: 0 };
    level.ms += dur;
    level.tokens += rate * dur;
    busy.set(k, level);
    unionMs += dur;
  }

  let sumMs = 0;
  let totalTokens = 0;
  const points: ConcurrencyPoint[] = spans.map((sp) => {
    const dur = sp.end - sp.start;
    sumMs += dur;
    totalTokens += sp.output;
    const meanK = sp.kMs / dur;
    return { meanK, k: Math.max(1, Math.round(meanK)), speed: sp.speed };
  });

  const solo = busy.get(1);
  const soloTps = solo && solo.ms > 0 ? (solo.tokens / solo.ms) * 1000 : 0;
  let maxK = 0;
  for (const k of busy.keys()) if (k > maxK) maxK = k;

  const speedsByK = new Map<number, number[]>();
  for (const p of points) {
    const list = speedsByK.get(p.k) ?? [];
    list.push(p.speed);
    speedsByK.set(p.k, list);
  }

  const levels: ConcurrencyLevel[] = [];
  for (let k = 1; k <= maxK; k++) {
    const level = busy.get(k);
    if (!level || level.ms <= 0) continue;
    const systemTps = (level.tokens / level.ms) * 1000;
    const speeds = speedsByK.get(k) ?? [];
    levels.push({
      k,
      busyMs: level.ms,
      share: unionMs > 0 ? level.ms / unionMs : 0,
      tokens: level.tokens,
      systemTps,
      requests: speeds.length,
      perStreamMedian: median(speeds),
      speedup: soloTps > 0 ? systemTps / soloTps : 0,
      idealTps: k * soloTps,
    });
  }

  return {
    segments,
    levels,
    points,
    totalTokens,
    unionMs,
    sumMs,
    systemTps: unionMs > 0 ? (totalTokens / unionMs) * 1000 : 0,
    perStreamTps: sumMs > 0 ? (totalTokens / sumMs) * 1000 : 0,
    meanConcurrency: unionMs > 0 ? sumMs / unionMs : 0,
    soloTps,
    maxK,
    timed: spans.length,
    untimed,
  };
}

/**
 * Time-weighted histogram of the system decode rate. Each segment is one
 * sample whose weight is its duration, so a bar is the share of busy time the
 * system spent producing tokens at that rate. Reuses the prefill binning.
 */
export function buildSystemDecodeTime(data: ConcurrencyData, binCount = 18): PrefillTimeData {
  const samples: PrefillSample[] = data.segments.map((s) => ({
    speed: s.systemTps,
    prefillMs: s.end - s.start,
  }));
  return { ...buildPrefillTime(samples, binCount), untimed: data.untimed };
}
