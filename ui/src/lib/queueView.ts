import type { QueueRequest, QueueSnapshot } from "./types";

// What the queue panel draws, derived from one upstream scheduler snapshot.
// The KV axis is the full-attention pool (kv_tokens_total): each running
// request's held context, then the output reserve the KV-fit gate counts for
// it on top (admit_tokens - kv_tokens), then the prefix cache of finished
// turns (evictable, so the gate treats it as room), then free. A waiting
// request fits when its admit_tokens fit in total minus what running
// requests commit; that is the gate's own arithmetic (fresh_fits).

export type SegmentKind = "held" | "reserve" | "cache" | "free";

export interface KVSegment {
  kind: SegmentKind;
  start: number; // tokens from the left edge
  tokens: number;
  request?: QueueRequest;
}

export interface KVLayout {
  total: number;
  segments: KVSegment[];
  committed: number; // held + reserve over running requests
  room: number; // what the gate sees as free: total - committed
  cache: number;
  free: number;
}

export function isRunning(r: QueueRequest): boolean {
  return r.queue_pos === undefined && (r.state === "prefill" || r.state === "decode");
}

export function runningRequests(s: QueueSnapshot): QueueRequest[] {
  return s.requests.filter(isRunning).sort((a, b) => a.id - b.id);
}

export function waitingRequests(s: QueueSnapshot): QueueRequest[] {
  return s.requests
    .filter((r) => r.queue_pos !== undefined)
    .sort((a, b) => (a.queue_pos ?? 0) - (b.queue_pos ?? 0));
}

// The output reserve the gate counts beyond what a running request holds.
export function reserveTokens(r: QueueRequest): number {
  return Math.max(0, (r.admit_tokens ?? 0) - r.kv_tokens);
}

export function kvLayout(s: QueueSnapshot): KVLayout {
  const total = Math.max(1, s.kv_tokens_total);
  const segments: KVSegment[] = [];
  let at = 0;
  const push = (kind: SegmentKind, tokens: number, request?: QueueRequest) => {
    const t = Math.max(0, Math.min(tokens, total - at));
    if (t <= 0) return;
    segments.push({ kind, start: at, tokens: t, request });
    at += t;
  };
  const running = runningRequests(s);
  for (const r of running) push("held", r.kv_tokens, r);
  for (const r of running) push("reserve", reserveTokens(r), r);
  const committed = at;
  push("cache", s.kv_tokens_cached);
  const cache = at - committed;
  push("free", total - at);
  return { total, segments, committed, room: total - committed, cache, free: total - committed - cache };
}

// priority + waited / aging_s: the order admission serves (ahead_of).
export function effectivePriority(r: QueueRequest, agingS: number, ageS = r.age_s): number {
  return agingS > 0 ? r.priority + ageS / agingS : r.priority;
}

// The seconds a held request still lets smaller ones pass, or null when
// backfill is off or the request is not held.
export function backfillLeftS(r: QueueRequest, backfillMs: number, heldS = r.held_s): number | null {
  if (r.wait !== "kv_hold" || heldS === undefined || backfillMs <= 0) return null;
  return Math.max(0, backfillMs / 1000 - heldS);
}

export interface WaitReason {
  label: string; // short badge text
  detail: string; // one line of why
  tone: "hold" | "blocked" | "pending" | "info";
}

export function waitReason(
  r: QueueRequest,
  layout: KVLayout,
  backfillMs: number,
  heldS = r.held_s
): WaitReason {
  const need = r.admit_tokens ?? 0;
  switch (r.wait) {
    case "kv_hold": {
      const left = backfillLeftS(r, backfillMs, heldS);
      const short = Math.max(0, need - layout.room);
      const head = `needs ${formatTokens(need)}, ${formatTokens(layout.room)} free (short ${formatTokens(short)})`;
      if (left !== null && left > 0)
        return { label: "Held for KV", detail: `${head}; smaller requests may pass for ${left.toFixed(0)}s`, tone: "hold" };
      return { label: "Held for KV", detail: `${head}; holding the line until running requests finish`, tone: "blocked" };
    }
    case "behind":
      return { label: "Behind", detail: "waits behind a held request at the front of the line", tone: "blocked" };
    case "kv_room":
      return {
        label: r.state === "preempted" ? "Preempted" : "KV room",
        detail: "waits for room to recompute its whole context",
        tone: "blocked",
      };
    case "media":
      return { label: "Encoding", detail: "its images or audio are being encoded", tone: "info" };
    default:
      return {
        label: "Next step",
        detail: need > 0 && need > layout.room ? "not reached yet; will be checked for KV room" : "admitted at the next scheduler step",
        tone: "pending",
      };
  }
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

// Ticks sit on powers of two, so label them in binary k (65536 -> "64k").
export function formatTick(t: number): string {
  return t === 0 ? "0" : `${Math.round(t / 1024)}k`;
}

// Axis ticks at round token counts: the largest step from 8k, 16k, 32k,
// 64k, ... that gives at least four intervals.
export function kvTicks(total: number): number[] {
  let step = 8192;
  while (total / (step * 2) >= 4) step *= 2;
  const ticks: number[] = [];
  for (let t = 0; t <= total; t += step) ticks.push(t);
  return ticks;
}

// Stable colour slots: a request keeps the slot it first got while it stays
// in the snapshot (colour follows the entity, never its rank); a new one
// takes the lowest slot no live request holds.
export class SlotAssigner {
  private slots = new Map<string, number>();
  constructor(private readonly count: number) {}

  assign(keys: string[]): Map<string, number> {
    const live = new Set(keys);
    for (const k of [...this.slots.keys()]) if (!live.has(k)) this.slots.delete(k);
    const used = new Set(this.slots.values());
    for (const k of keys) {
      if (this.slots.has(k)) continue;
      let slot = 0;
      while (used.has(slot) && slot < this.count - 1) slot++;
      used.add(slot);
      this.slots.set(k, slot);
    }
    return new Map(this.slots);
  }
}

export function requestKey(model: string, r: QueueRequest): string {
  return `${model}#${r.id}`;
}
