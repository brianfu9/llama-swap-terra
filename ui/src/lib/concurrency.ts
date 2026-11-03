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
// Preemption: an engine that preempts (Radiance) reports preempted_ms, the
// part of predicted_ms the request spent out of the batch. Counting that time
// as decoding inflates k past the slot count and deflates the request's speed,
// so every placement here uses the ACTIVE decode time, predicted_ms minus
// preempted_ms, and the active speed, output / active time. The active time is
// still placed as one contiguous window [endMs - active, endMs]: the engine
// reports only a total, not when the preempted stretches were, so this is an
// approximation that puts all the active time at the end of the request.
//
// Solo-equivalent speed: what a request would have decoded at had it run
// alone. Measured per-stream slowdown at k is soloPerStream / perStream(k) =
// k / speedup(k); a request's solo-equivalent is its active speed times the
// slowdown at its time-weighted mean k, interpolated linearly between whole
// levels. It is NOT speed x k or the system rate, both of which count the
// other streams' tokens as this request's.
//
// Prefill of one slot runs in the same batches as decode of another, so that
// time lands inside the other request's decode interval. The per-stream rate
// blames it on decode; the system rate counts it correctly, because tokens
// over union time does not care which slot owned the batch.

/** One request's decode, as the stats endpoint reports it. */
export interface DecodeSample {
  /** Unix ms the response finished. */
  endMs?: number;
  /** llama-server's predicted_ms. <= 0 means the request reported no timing. */
  decodeMs?: number;
  /** Part of decodeMs spent preempted out of the batch; absent or <= 0 means none. */
  preemptedMs?: number;
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
  /**
   * Per-stream slowdown vs solo, k / speedup: how much slower one stream
   * decodes at this k than alone. 1 at k = 1. 0 when unreliable: no solo
   * baseline, or this level or the solo level has under MIN_LEVEL_BUSY_MS.
   */
  slowdown: number;
}

/** One request placed by its time-weighted concurrency. */
export interface ConcurrencyPoint {
  /** Time-weighted mean of k over the request's decode. */
  meanK: number;
  /** meanK rounded to the nearest whole level, at least 1. */
  k: number;
  /** Active decode speed: output / (decodeMs - preemptedMs). The reported speed when nothing was preempted. */
  speed: number;
  /**
   * Estimated tok/s had this request run alone: speed x slowdown(meanK),
   * slowdown interpolated between whole levels. Equals speed when meanK <= 1,
   * and when a level it needs is unreliable (see ConcurrencyLevel.slowdown).
   */
  soloEquiv: number;
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
  /**
   * Per input sample, in input order: the system rate averaged over that
   * request's own decode. A solo request keeps its own rate; a request that
   * shared the GPU gets what the GPU produced in total meanwhile. NaN for a
   * sample that could not be placed (no timing), so callers can fall back to
   * the reported speed.
   */
  systemSpeeds: number[];
  /**
   * Per input sample, in input order: the request's solo-equivalent speed
   * (ConcurrencyPoint.soloEquiv). NaN for a sample that could not be placed.
   */
  soloSpeeds: number[];
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
  systemSpeeds: [],
  soloSpeeds: [],
  timed: 0,
  untimed: 0,
};

/**
 * Busy time a level (and the solo baseline) needs before its slowdown is
 * trusted. A level seen for a few seconds measures noise; requests that would
 * need it keep their own speed rather than an extrapolated one.
 */
export const MIN_LEVEL_BUSY_MS = 60_000;

/**
 * Active decode time: decodeMs minus the preempted part. Falls back to decodeMs
 * when preemptedMs is missing, not positive, or not smaller than decodeMs.
 */
export function activeDecodeMs(decodeMs: number, preemptedMs: number | undefined): number {
  if (preemptedMs === undefined || !Number.isFinite(preemptedMs) || preemptedMs <= 0) return decodeMs;
  const active = decodeMs - preemptedMs;
  return active > 0 ? active : decodeMs;
}

/**
 * Per-stream slowdown at a fractional mean k, linearly interpolated between
 * the whole levels around it. 1 at k <= 1. NaN when a bracketing level has no
 * trusted slowdown (see ConcurrencyLevel.slowdown), so callers keep the raw
 * speed instead of extrapolating.
 */
export function slowdownAt(meanK: number, slowdownByK: Map<number, number>): number {
  if (!(meanK > 1)) return 1;
  const lo = Math.floor(meanK);
  const hi = Math.ceil(meanK);
  const sLo = lo <= 1 ? 1 : slowdownByK.get(lo);
  if (sLo === undefined || !(sLo > 0)) return NaN;
  if (hi === lo) return sLo;
  const sHi = slowdownByK.get(hi);
  if (sHi === undefined || !(sHi > 0)) return NaN;
  return sLo + (meanK - lo) * (sHi - sLo);
}

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
  /** Tokens the whole system produced while this span was running. */
  sysTokens: number;
  /** Index into the input samples. */
  index: number;
}

export function buildConcurrency(samples: DecodeSample[]): ConcurrencyData {
  const spans: Span[] = [];
  let untimed = 0;
  const systemSpeeds = new Array<number>(samples.length).fill(NaN);
  const soloSpeeds = new Array<number>(samples.length).fill(NaN);
  for (const [index, s] of samples.entries()) {
    if (!Number.isFinite(s.speed) || s.speed <= 0 || !(s.output > 0)) continue;
    const end = s.endMs;
    const ms = s.decodeMs;
    // end_ms is 0 on a row the backend could not place (pre-migration
    // databases backfill it, so this is only a defensive check).
    if (end === undefined || !Number.isFinite(end) || end <= 0 || ms === undefined || !Number.isFinite(ms) || ms <= 0) {
      untimed++;
      continue;
    }
    const active = activeDecodeMs(ms, s.preemptedMs);
    spans.push({
      start: end - active,
      end,
      rate: s.output / active,
      output: s.output,
      // Scale the reported speed rather than recompute output / active, so a
      // request with nothing preempted keeps its reported figure exactly.
      speed: s.speed * (ms / active),
      kMs: 0,
      sysTokens: 0,
      index,
    });
  }
  if (spans.length === 0) return { ...EMPTY, systemSpeeds, soloSpeeds, untimed };

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
    for (const idx of active) rate += spans[idx].rate;
    for (const idx of active) {
      spans[idx].kMs += k * dur;
      spans[idx].sysTokens += rate * dur;
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
    // Solo, sysTokens/dur is the span's own token rate (output / predicted_ms)
    // rather than the reported speed, which can differ by rounding; keep the
    // reported figure there so solo points do not move when this mode is on.
    systemSpeeds[sp.index] = meanK <= 1 + 1e-9 ? sp.speed : (sp.sysTokens / dur) * 1000;
    return { meanK, k: Math.max(1, Math.round(meanK)), speed: sp.speed, soloEquiv: sp.speed };
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
  const slowdownByK = new Map<number, number>();
  const soloTrusted = soloTps > 0 && (solo?.ms ?? 0) >= MIN_LEVEL_BUSY_MS;
  for (let k = 1; k <= maxK; k++) {
    const level = busy.get(k);
    if (!level || level.ms <= 0) continue;
    const systemTps = (level.tokens / level.ms) * 1000;
    const speeds = speedsByK.get(k) ?? [];
    const speedup = soloTps > 0 ? systemTps / soloTps : 0;
    const slowdown = soloTrusted && level.ms >= MIN_LEVEL_BUSY_MS && speedup > 0 ? k / speedup : 0;
    if (slowdown > 0) slowdownByK.set(k, slowdown);
    levels.push({
      k,
      busyMs: level.ms,
      share: unionMs > 0 ? level.ms / unionMs : 0,
      tokens: level.tokens,
      systemTps,
      requests: speeds.length,
      perStreamMedian: median(speeds),
      speedup,
      idealTps: k * soloTps,
      slowdown,
    });
  }

  // Solo-equivalent needs the levels, so it is a second pass over the points.
  points.forEach((p, i) => {
    const factor = soloTrusted ? slowdownAt(p.meanK, slowdownByK) : NaN;
    if (Number.isFinite(factor)) p.soloEquiv = p.speed * factor;
    soloSpeeds[spans[i].index] = p.soloEquiv;
  });

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
    systemSpeeds,
    soloSpeeds,
    timed: spans.length,
    untimed,
  };
}
