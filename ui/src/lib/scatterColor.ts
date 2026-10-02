// Color assignment for the activity-page scatter charts.
//
// A scatter plot can only carry three categorically-distinct session colors
// safely, so assignSessionSlots hands out exactly three slots to the latest
// sessions; everything else falls back to the neutral "Other" gray.

export const SESSION_SLOTS_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a"];
export const SESSION_SLOTS_DARK = ["#3987e5", "#d95926", "#199e70"];
export const OTHER_LIGHT = "#6b7280";
export const OTHER_DARK = "#9ca3af";
export const ACCEPT_RAMP_LIGHT = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281"];
export const ACCEPT_RAMP_DARK = ["#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4"];

/**
 * Rank non-empty sessions by their most recent appearance in the input and
 * assign slot indexes 0..2 to the three latest. The input is ordered
 * oldest-to-newest (see Store.speedValues), so a higher index is more recent.
 * All other sessions — and "" — are absent from the map ("Other").
 * Last-appearance indexes are unique per session, so no tie-break is needed.
 */
export function assignSessionSlots(sessions: string[]): Map<string, number> {
  const lastSeen = new Map<string, number>();
  for (let index = 0; index < sessions.length; index++) {
    const session = sessions[index];
    if (session === "") continue;
    lastSeen.set(session, index);
  }
  const ranked = [...lastSeen.entries()].sort((a, b) => b[1] - a[1]);
  const slots = new Map<string, number>();
  ranked.slice(0, 3).forEach(([session], index) => slots.set(session, index));
  return slots;
}

/** Slot color for a mapped session, otherwise the neutral "Other" gray. */
export function sessionColor(session: string, slots: Map<string, number>, dark: boolean): string {
  const slot = slots.get(session);
  if (slot === undefined) return dark ? OTHER_DARK : OTHER_LIGHT;
  return (dark ? SESSION_SLOTS_DARK : SESSION_SLOTS_LIGHT)[slot];
}

/**
 * Bucket an acceptance rate into 0..4 with boundaries at 0.5, 0.6, 0.7, 0.8.
 * Returns -1 when accept < 0 (no draft data).
 */
export function acceptBucket(accept: number): number {
  if (accept < 0) return -1;
  if (accept < 0.5) return 0;
  if (accept < 0.6) return 1;
  if (accept < 0.7) return 2;
  if (accept < 0.8) return 3;
  return 4;
}

/** Ramp color for an acceptance rate, or the neutral gray with no draft data. */
export function acceptColor(accept: number, dark: boolean): string {
  const bucket = acceptBucket(accept);
  if (bucket === -1) return dark ? OTHER_DARK : OTHER_LIGHT;
  return (dark ? ACCEPT_RAMP_DARK : ACCEPT_RAMP_LIGHT)[bucket];
}

/** Last 6 characters of a session id, or the whole string when shorter. */
export function shortSession(session: string): string {
  if (session === "") return "";
  return session.length <= 6 ? session : session.slice(-6);
}

/**
 * Point radius for an output-token count, scaled against the dataset's p95
 * cap: clamp(1.5, 7, 1.5 + 5.5 * sqrt(min(output, cap) / cap)).
 * Returns 1.5 when cap <= 0 and never returns NaN.
 *
 * The ceiling is deliberately low. Decode context clusters in a narrow band,
 * so a few hundred points overlap heavily; larger dots turn that cluster into
 * an unreadable blob. The floor is low for the same reason — short requests
 * are the bulk of the cluster, and shrinking them opens it up without costing
 * the long requests any size.
 */
export function dotRadius(output: number, cap: number): number {
  if (cap <= 0 || !Number.isFinite(output)) return 1.5;
  const ratio = Math.max(0, Math.min(output, cap)) / cap;
  const radius = 1.5 + 5.5 * Math.sqrt(ratio);
  return Math.min(7, Math.max(1.5, radius));
}

/**
 * Sequential density ramp for the speed heatmaps — one blue hue, ordered
 * light-to-dark on light and dark-to-light on dark, since on a dark card
 * "more" has to read as brighter.
 *
 * Both ramps stay inside the palette's ORDINAL-safe band (light no lighter
 * than step 250, dark no darker than step 600), not the wider sequential one.
 * The sequential band lets its end step recede into the surface, which is
 * correct when that step means "near zero" — but here every painted cell is a
 * real request, and a cell you cannot see is a cell that reads as no data.
 * Steps are ~0.071 apart in OKLab L, the widest even spacing the band allows.
 */
export const DENSITY_RAMP_LIGHT = [
  "#86b6ef",
  "#5598e7",
  "#3987e5",
  "#256abf",
  "#1c5cab",
  "#104281",
  "#0d366b",
];
export const DENSITY_RAMP_DARK = [
  "#184f95",
  "#256abf",
  "#2a78d6",
  "#5598e7",
  "#6da7ec",
  "#9ec5f4",
  "#cde2fb",
];

/**
 * Accent for the latest-session overlay. Slot 2 (orange) against the blue
 * density ramp is the widest separation in the palette — it clears the
 * colorblind floor by a wide margin in both modes, which matters because the
 * overlay is drawn directly on top of the cells it has to be told apart from.
 */
export const LATEST_LIGHT = SESSION_SLOTS_LIGHT[1];
export const LATEST_DARK = SESSION_SLOTS_DARK[1];

/** Ramp for the given mode. */
export function densityRamp(dark: boolean): string[] {
  return dark ? DENSITY_RAMP_DARK : DENSITY_RAMP_LIGHT;
}

/**
 * Per-step upper bounds for the density ramp, by RANK rather than by value.
 *
 * Scaling against the maximum is what made the first version of these charts
 * unreadable: one hot cell held 225 requests while the typical cell held 1-5,
 * so nearly every cell computed to the faintest step and the grid looked
 * uniformly blank. Capping at a high quantile fixed that for the skewed
 * prefill grid but not for the decode grid, whose counts are not skewed —
 * there a log mapping pushed 42% of cells into the two darkest steps and the
 * dense spine turned into one flat navy mass with no structure inside it.
 *
 * Equalizing on rank solves both at once: each step takes roughly 1/n of the
 * populated cells whatever the shape of the distribution. Measured on real
 * terra data this moves both grids to within a few points of an even 14% per
 * step. Ties (the many count-1 cells) still bunch in the lowest step, which is
 * unavoidable and harmless.
 *
 * The trade-off is that color is no longer linear in count, so the returned
 * bounds are what the legend must show for the scale to be readable.
 */
export function densityThresholds(counts: number[], steps = DENSITY_RAMP_LIGHT.length): number[] {
  const populated = counts.filter((count) => count > 0).sort((a, b) => a - b);
  if (populated.length === 0 || steps < 1) return [];
  const bounds: number[] = [];
  for (let step = 1; step <= steps; step++) {
    const index = Math.min(populated.length - 1, Math.ceil((step / steps) * populated.length) - 1);
    bounds.push(populated[index]);
  }
  return bounds;
}

/**
 * Ramp index for a cell count given densityThresholds' bounds, or -1 for an
 * empty cell. Bounds are inclusive upper limits, so the first step whose bound
 * the count does not exceed wins.
 */
export function densityBucket(count: number, thresholds: number[]): number {
  if (count <= 0 || thresholds.length === 0) return -1;
  for (let step = 0; step < thresholds.length; step++) {
    if (count <= thresholds[step]) return step;
  }
  return thresholds.length - 1;
}

/** Density ramp color for a cell count; empty cells are not painted. */
export function densityColor(count: number, thresholds: number[], dark: boolean): string {
  const ramp = densityRamp(dark);
  const bucket = densityBucket(count, thresholds);
  if (bucket < 0) return "transparent";
  return ramp[Math.min(bucket, ramp.length - 1)];
}

/**
 * Opacity for a cell whose hue already carries a metric, so density can ride
 * along on the alpha channel. Floors at 0.35 — a cell that exists should stay
 * visible — and reaches 1 in the densest step.
 */
export function densityAlpha(count: number, thresholds: number[]): number {
  const bucket = densityBucket(count, thresholds);
  if (bucket < 0) return 0;
  const steps = thresholds.length;
  if (steps <= 1) return 1;
  return 0.35 + (0.65 * Math.min(bucket, steps - 1)) / (steps - 1);
}

/** Append an alpha channel to a #rrggbb color. */
export function withAlpha(hex: string, alpha: number): string {
  const clamped = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return hex + clamped.toString(16).padStart(2, "0");
}

/**
 * The session that appears last in an oldest-to-newest list, or "" when none
 * of the points carry a session. This is the one session drawn as individual
 * points on top of the density grid.
 */
export function latestSession(sessions: string[]): string {
  for (let index = sessions.length - 1; index >= 0; index--) {
    if (sessions[index] !== "") return sessions[index];
  }
  return "";
}
