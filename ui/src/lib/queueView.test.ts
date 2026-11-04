import { describe, expect, it } from "vitest";
import type { QueueRequest, QueueSnapshot } from "./types";
import {
  SlotAssigner,
  backfillLeftS,
  effectivePriority,
  formatTick,
  formatTokens,
  kvLayout,
  kvTicks,
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
    expect(waitReason(head, l, 60000).detail).toBe(
      "needs 120k, 84k free (short 36k); smaller requests may pass for 40s"
    );
    expect(waitReason(head, l, 60000, 75).tone).toBe("blocked");
    expect(waitReason(waitingRequests(s)[1], l, 60000).label).toBe("Behind");
  });

  it("ages priority by waited seconds", () => {
    expect(effectivePriority(req({ priority: 2, age_s: 45 }), 30)).toBeCloseTo(3.5);
    expect(effectivePriority(req({ priority: 2, age_s: 45 }), 0)).toBe(2);
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

describe("formatting", () => {
  it("formats tokens and picks round ticks", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(16384)).toBe("16k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(kvTicks(287_584)).toEqual([0, 65536, 131072, 196608, 262144]);
    expect(kvTicks(287_584).map(formatTick)).toEqual(["0", "64k", "128k", "192k", "256k"]);
  });
});
