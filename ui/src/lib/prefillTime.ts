// Time-weighted binning for the prefill histogram.
//
// This is the speed histogram, fixed. The original binned prefill speed and
// counted requests, and request count is a bad proxy for where prefill time
// goes: on terra's real traffic its first bin held 777 short requests that
// each cost milliseconds, while the handful of 100k-token prefills that
// dominate the actual wall clock were invisible.
//
// Same x axis, different weight — bin by prefill speed, and make the bar the
// *summed seconds* spent prefilling at that speed. The tall bar is then the
// rate you actually spend your time at, which is the number worth tuning.
//
// Bins are linear, not log. Speed spans about 1.5 decades here and the
// time-weighted mass sits in the upper half; a log axis would expand the
// near-empty slow tail and compress exactly the region of interest.

/** One request's prefill speed and the wall-clock prefill it cost. */
export interface PrefillSample {
  /** Prefill rate in tokens/sec. */
  speed: number;
  /** llama-server's prompt_ms. <= 0 means the request reported no timing. */
  prefillMs?: number;
}

export interface PrefillBin {
  /** Bin bounds in tokens/sec; edges are evenly spaced. */
  lo: number;
  hi: number;
  /** Requests in the bin that carried a usable timing. */
  count: number;
  /** Total wall-clock prefill attributed to the bin. */
  seconds: number;
  /** seconds / count, the typical cost of one prefill at this rate. */
  meanSeconds: number;
  /** Share of all attributed prefill time, 0..1. */
  share: number;
}

export interface PrefillTimeData {
  bins: PrefillBin[];
  /** Total attributed prefill seconds across every bin. */
  totalSeconds: number;
  maxSeconds: number;
  /**
   * Speed percentiles weighted by TIME, not by request count: p50 is the speed
   * below which half of all prefill seconds were spent.
   *
   * The decode histogram's markers are count-weighted, but this chart's bars
   * are seconds, and a count-weighted marker drawn over them would not split
   * the area it appears to split.
   *
   * The two weightings diverge a lot, and NOT in the direction you might
   * assume. Measured on terra: time-weighted p1/p10/p50 = 42/131/382 t/s
   * against count-weighted 28/40/191. Time weighting comes out *faster*
   * because the long prompts both own the time budget and prefill at high
   * throughput, while the many short prompts are slow per token yet cost
   * almost no wall clock. Whichever way it leans on other traffic, the
   * markers answer "what rate is my prefill time spent at", not "how slow is
   * a typical request".
   */
  p1: number;
  p10: number;
  p50: number;
  /** Requests carrying a usable timing. */
  timed: number;
  /**
   * Requests dropped for having no timing. Surfaced rather than silently
   * swallowed: if this is most of the data the chart is not representative.
   */
  untimed: number;
}

const EMPTY: PrefillTimeData = {
  bins: [],
  totalSeconds: 0,
  maxSeconds: 0,
  p1: 0,
  p10: 0,
  p50: 0,
  timed: 0,
  untimed: 0,
};

/**
 * Speed at which the cumulative prefill time first reaches `quantile` of the
 * total. Input must be sorted by speed ascending.
 */
function timeWeightedQuantile(
  sorted: { speed: number; seconds: number }[],
  totalSeconds: number,
  quantile: number,
): number {
  if (sorted.length === 0 || totalSeconds <= 0) return 0;
  const target = quantile * totalSeconds;
  let cumulative = 0;
  for (const sample of sorted) {
    cumulative += sample.seconds;
    if (cumulative >= target) return sample.speed;
  }
  return sorted[sorted.length - 1].speed;
}

/**
 * Bin samples by prefill speed and sum their prefill seconds.
 *
 * Samples without a usable timing (prefillMs <= 0 — see the two sentinels in
 * store_test.go) are counted in `untimed` and contribute no time, since
 * attributing zero seconds to them would understate their bin and attributing
 * an average would invent data.
 */
export function buildPrefillTime(samples: PrefillSample[], binCount = 18): PrefillTimeData {
  if (binCount < 1) return EMPTY;

  const usable: { speed: number; seconds: number }[] = [];
  let untimed = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample.speed) || sample.speed <= 0) continue;
    const ms = sample.prefillMs;
    if (ms === undefined || !Number.isFinite(ms) || ms <= 0) {
      untimed++;
      continue;
    }
    usable.push({ speed: sample.speed, seconds: ms / 1000 });
  }
  if (usable.length === 0) return { ...EMPTY, untimed };

  let lo = Infinity;
  let hi = -Infinity;
  for (const { speed } of usable) {
    if (speed < lo) lo = speed;
    if (speed > hi) hi = speed;
  }

  const step = (hi - lo) / binCount;
  const totals = new Array<number>(binCount).fill(0);
  const counts = new Array<number>(binCount).fill(0);
  let totalSeconds = 0;
  for (const { speed, seconds } of usable) {
    const index =
      step > 0 ? Math.min(binCount - 1, Math.max(0, Math.floor((speed - lo) / step))) : 0;
    totals[index] += seconds;
    counts[index]++;
    totalSeconds += seconds;
  }

  const bins: PrefillBin[] = [];
  let maxSeconds = 0;
  // A zero step means every request ran at the same speed: emit the single
  // occupied bin rather than binCount copies of it.
  const emitted = step > 0 ? binCount : 1;
  for (let index = 0; index < emitted; index++) {
    const seconds = totals[index];
    const count = counts[index];
    bins.push({
      lo: lo + index * step,
      hi: lo + (index + 1) * step,
      count,
      seconds,
      meanSeconds: count > 0 ? seconds / count : 0,
      share: totalSeconds > 0 ? seconds / totalSeconds : 0,
    });
    if (seconds > maxSeconds) maxSeconds = seconds;
  }

  const bySpeed = [...usable].sort((a, b) => a.speed - b.speed);
  return {
    bins,
    totalSeconds,
    maxSeconds,
    p1: timeWeightedQuantile(bySpeed, totalSeconds, 0.01),
    p10: timeWeightedQuantile(bySpeed, totalSeconds, 0.1),
    p50: timeWeightedQuantile(bySpeed, totalSeconds, 0.5),
    timed: usable.length,
    untimed,
  };
}
