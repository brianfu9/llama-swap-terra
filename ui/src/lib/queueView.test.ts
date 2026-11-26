import { describe, expect, it } from "vitest";
import type { QueueRequest, QueueSnapshot } from "./types";
import {
  AgeRatchet,
  SlotAssigner,
  backfillLeftS,
  effectivePriority,
  formatTick,
  formatTokens,
  kvLayout,
  kvTicks,
  outputRoom,
  runningRequests,
  waitReason,
  waitingRequests,
} from "./queueView";

function req(over: Partial<QueueRequest>): QueueRequest {
  return {
    id: 1, state: "decode", prompt: 0, computed: 0, cached: 0, output: 0, max: 32768,
    kv_tokens: 0, age_s: 0, tps: 0, priority: 0, ...over,
  };
}

function snap(requests: QueueRequest[], over: Partial<QueueSnapshot> = {}): QueueSnapshot {
  return {
    model: "rad", at_ms: 0, kv_tokens_total: 200_000, kv_tokens_used: 0, kv_tokens_cached: 0,
    running: 0, waiting: 0, decode_tps: 0, prefill_tps: 0, preemptions: 0,
    queue: { kv_reserve: 16384, backfill_ms: 60000, aging_s: 30 }, requests, ...over,
  };
}

describe("kvLayout", () => {
  it("lays out held, then reserve, then cache, then free, and the gate's room", () => {
    const s = snap(
      [
        req({ id: 2, kv_tokens: 50_000, admit_tokens: 66_384 }),
        req({ id: 1, state: "prefill", kv_tokens: 30_000, admit_tokens: 46_384 }),
        req({ id: 3, state: "waiting", queue_pos: 0, wait: "kv_hold", admit_tokens: 100_000 }),
      ],
      { kv_tokens_cached: 40_000 }
    );
    const l = kvLayout(s);
    expect(l.segments.map((g) => [g.kind, g.request?.id ?? null, g.tokens])).toEqual([
      ["held", 1, 30_000],
      ["held", 2, 50_000],
      ["reserve", 1, 16_384],
      ["reserve", 2, 16_384],
      ["cache", null, 40_000],
      ["free", null, 200_000 - 112_768 - 40_000],
    ]);
    expect(l.committed).toBe(112_768);
    expect(l.room).toBe(87_232);
    expect(l.segments[3].start).toBe(96_384);
  });

  it("lets the reserve claim the evictable cache and never draws past the pool", () => {
    const s = snap([req({ kv_tokens: 150_000, admit_tokens: 166_384 })], { kv_tokens_cached: 60_000 });
    const l = kvLayout(s);
    expect(l.cache).toBe(200_000 - 166_384);
    expect(l.free).toBe(0);
    expect(l.segments.reduce((n, g) => n + g.tokens, 0)).toBe(200_000);
  });
});

describe("queue order and reasons", () => {
  const s = snap([
    req({ id: 5, state: "waiting", queue_pos: 1, wait: "behind", admit_tokens: 8000 }),
    req({ id: 4, state: "waiting", queue_pos: 0, wait: "kv_hold", held_s: 20, admit_tokens: 120_000 }),
    req({ id: 3, kv_tokens: 100_000, admit_tokens: 116_384 }),
  ]);
  const l = kvLayout(s);

  it("splits running from waiting and keeps service order", () => {
    expect(runningRequests(s).map((r) => r.id)).toEqual([3]);
    expect(waitingRequests(s).map((r) => r.id)).toEqual([4, 5]);
  });

  it("explains a held request inside and past its backfill window", () => {
    const head = waitingRequests(s)[0];
    expect(backfillLeftS(head, 60000)).toBe(40);
    // needs and room live in the Needs column and the model header, so the
    // detail only adds what is short and how long backfill still passes.
    expect(waitReason(head, l, 60000)).toEqual({
      label: "Held for KV",
      detail: "short 36k · 40s backfill left",
      tone: "hold",
    });
    expect(waitReason(head, l, 60000, 75)).toEqual({
      label: "Held for KV",
      detail: "short 36k · holds the line",
      tone: "blocked",
    });
    expect(waitReason(waitingRequests(s)[1], l, 60000)).toEqual({
      label: "Behind",
      detail: "held request ahead",
      tone: "blocked",
    });
  });

  it("ages priority by waited seconds", () => {
    expect(effectivePriority(req({ priority: 2, age_s: 45 }), 30)).toBeCloseTo(3.5);
    expect(effectivePriority(req({ priority: 2, age_s: 45 }), 0)).toBe(2);
  });
});

describe("gate room", () => {
  it("caps the output room at --admit-kv-reserve, at what is left, or at the reserve", () => {
    // min(kv_reserve, max - output), per radiance's gate_blocks
    expect(outputRoom(req({ prompt: 100_000, computed: 8_000, output: 0, max: 32_768 }), 16_384)).toBe(16_384);
    expect(outputRoom(req({ output: 30_000, max: 32_768 }), 16_384)).toBe(2_768);
    // max unset: the full reserve; gate off: nothing
    expect(outputRoom(req({ max: 0 }), 16_384)).toBe(16_384);
    expect(outputRoom(req({}), 0)).toBe(0);
  });
});

describe("SlotAssigner", () => {
  it("keeps a request's slot and reuses the lowest free one", () => {
    const a = new SlotAssigner(4);
    expect([...a.assign(["x", "y", "z"]).entries()]).toEqual([["x", 0], ["y", 1], ["z", 2]]);
    const next = a.assign(["y", "z", "w"]);
    expect(next.get("y")).toBe(1);
    expect(next.get("z")).toBe(2);
    expect(next.get("w")).toBe(0);
  });
});

describe("AgeRatchet", () => {
  it("holds a row at its highest shown value across a stale re-baseline", () => {
    const r = new AgeRatchet();
    expect(r.age("rad#1", 0)).toBe(0);
    // the row's tick has counted up to 1; a snapshot stamped before that must
    // not pull the displayed timer backwards
    expect(r.age("rad#1", 1)).toBe(1);
    expect(r.age("rad#1", 0.85)).toBe(1);
    expect(r.age("rad#1", 0.9)).toBe(1);
    // a genuinely newer snapshot still advances it
    expect(r.age("rad#1", 2)).toBe(2);
  });

  it("accepts a drop past the margin as a fresh request reusing the key", () => {
    const r = new AgeRatchet();
    expect(r.age("rad#1", 10)).toBe(10);
    expect(r.age("rad#1", 8.1)).toBe(10); // within 2 s: jitter
    expect(r.age("rad#1", 0.5)).toBe(0.5); // an engine restart's id reuse
    expect(r.age("rad#1", 1.2)).toBe(1.2); // ticks forward from there, not back to 10
  });

  it("prune forgets keys that left so they can be reused fresh", () => {
    const r = new AgeRatchet();
    expect(r.age("rad#1", 5)).toBe(5);
    r.prune(["rad#2"]);
    expect(r.age("rad#1", 0.2)).toBe(0.2);
  });

  it("keeps a row's age and hold time on independent keys", () => {
    const r = new AgeRatchet();
    expect(r.age("rad#1", 3)).toBe(3);
    expect(r.age("h:rad#1", 1)).toBe(1);
    expect(r.age("rad#1", 3.1)).toBe(3.1);
    expect(r.age("h:rad#1", 0.9)).toBe(1);
  });
});

describe("formatting", () => {
  it("formats tokens and picks round ticks", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(16384)).toBe("16k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(kvTicks(287_584)).toEqual([0, 65536, 131072, 196608, 262144]);
    expect(kvTicks(287_584).map(formatTick)).toEqual(["0", "64k", "128k", "192k", "256k"]);
  });
});
